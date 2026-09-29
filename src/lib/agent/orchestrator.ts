import type {
  AccountMentalModel,
  AgentDecision,
  DecisionFactor,
  DraftRequest,
  DraftRun,
  DraftRunLearning,
  MemoryUsage,
  Observation,
  ObservationUsage,
  OutcomeReport,
  RecalledMemory,
  RetainedMemory,
} from "../types";
import { getMemoryProvider } from "../memory/factory";
import { recallQueryFor } from "../memory/provider";
import { evidenceFromOutcome, consolidate } from "../memory/consolidator";
import { getLLMProvider } from "../llm/factory";
import type { LLMProvider } from "../llm/provider";
import type { MemoryProvider } from "../memory/provider";
import { buildDraftPrompt, buildOutcomeMemory } from "./prompts";
import { getRunStore } from "../store/runs";

/**
 * The two-layer learning loop, explicitly staged:
 *
 *   Layer 1 (episodic):  INPUT → RECALL → REASON → ACT → OUTCOME → RETAIN
 *   Layer 2 (learned):   evidence → observation consolidation → mental model
 *
 * BEFORE acting, the agent consults episodic memories, consolidated
 * observations, and the account mental model — all via the MemoryProvider
 * abstraction. AFTER an outcome, the same outcome flows into episodic memory
 * (retain) AND the consolidation engine (pattern detection), so future
 * behavior changes at both layers.
 */
/**
 * Provider injection point — used only by tests to exercise failure paths
 * (memory outage, LLM failure) against the real orchestrator flow. Production
 * always uses the factories.
 */
const overrides: { memory?: MemoryProvider; llm?: LLMProvider } = {};
export function _setProviderOverridesForTests(o: typeof overrides): void {
  overrides.memory = o.memory;
  overrides.llm = o.llm;
}

export async function handleDraftRequest(req: DraftRequest): Promise<DraftRun> {
  const memory = overrides.memory ?? getMemoryProvider();
  const llm = overrides.llm ?? getLLMProvider();

  // Stage 2: RECALL — episodic memories AND consolidated knowledge.
  const recallQuery = recallQueryFor(req);
  let memories: RecalledMemory[] = [];
  let observations: Observation[] = [];
  let mentalModelSnapshot: NonNullable<DraftRunLearning["mentalModelSnapshot"]> | undefined;

  try {
    memories = await memory.recall(req);
  } catch (err) {
    // Memory outage must not kill the draft; it degrades to generic behavior.
    console.error("[orchestrator] recall failed, continuing without memory:", err);
  }
  try {
    // Independent reads, parallelized: observation recall and the mental model
    // do not depend on each other, and on Hindsight Cloud each is a network
    // round trip (measured 1–3s each sequentially).
    const [obs, modelResult] = await Promise.all([
      memory.recallObservations(req),
      memory.getAccountMentalModel(req.account.accountId),
    ]);
    observations = obs;
    const { model } = modelResult;
    mentalModelSnapshot = {
      generatedAt: model.generatedAt,
      beliefs: model.beliefs,
      uncertainties: model.uncertainties,
      approachesToRepeat: model.approachesToRepeat,
      approachesToAvoid: model.approachesToAvoid,
    };
  } catch (err) {
    console.error("[orchestrator] learning-layer recall failed, continuing:", err);
  }

  // Stage 3: REASON — six separate sections, distinct epistemics.
  const { system, user } = buildDraftPrompt({
    account: req.account,
    goal: req.goal,
    memories,
    observations,
    mentalModel: {
      accountId: req.account.accountId,
      generatedAt: mentalModelSnapshot?.generatedAt ?? new Date().toISOString(),
      beliefs: mentalModelSnapshot?.beliefs ?? [],
      uncertainties: mentalModelSnapshot?.uncertainties ?? [],
      approachesToRepeat: mentalModelSnapshot?.approachesToRepeat ?? [],
      approachesToAvoid: mentalModelSnapshot?.approachesToAvoid ?? [],
      observationIds: observations.map((o) => o.id),
    },
  });

  let planJson: string;
  try {
    planJson = await llm.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
  } catch (err) {
    throw new Error(`reasoning failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { plan, memoryUsage, observationUsage, decisionFields } = draftFromPlan(
    planJson,
    memories,
    observations
  );

  // Merge the plan's actual usage claims into the considered-observations list.
  const usageById = new Map(observationUsage.map((u) => [u.observationId, u]));
  const observationsConsidered: ObservationUsage[] = observations.map((o) => ({
    observationId: o.id,
    statement: o.statement,
    confidence: o.confidence,
    influence: usageById.get(o.id)?.influence ?? "",
  }));

  // Stage 4: ACT — persist full provenance (before-action knowledge snapshot).
  // The decision object is assembled from VALIDATED state only: reasoning
  // factors must reference memories/observations actually provided, so the
  // audit trail can never contain invented provenance.
  const constraints = (mentalModelSnapshot?.approachesToAvoid ?? []).map((a) => `Avoid: ${a}`);
  const decision: AgentDecision = {
    situation: `${req.account.company} — ${req.account.contactName} (${req.account.contactRole}). AE input: ${req.account.situationNotes || "none provided"}`,
    objective: req.goal ?? "follow up appropriately",
    constraints,
    beliefsConsulted: observations.map((o) => o.id),
    uncertainties: mentalModelSnapshot?.uncertainties ?? [],
    reasoningFactors: decisionFields.reasoningFactors,
    selectedStrategy:
      decisionFields.selectedStrategy ??
      `Experience-informed follow-up (${(plan.strategyLabels ?? []).join(", ") || "no labels"})`,
    action: {
      subject: plan.subject,
      body: plan.body,
      strategyLabels: plan.strategyLabels ?? [],
    },
    confidence:
      decisionFields.confidence ??
      (observations.some((o) => o.status === "active")
        ? 0.55
        : memories.length > 0
          ? 0.5
          : 0.4),
    expectedOutcome:
      decisionFields.expectedOutcome ?? "Outcome not predicted by the reasoning model.",
  };

  const run: DraftRun = {
    runId: `run_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    request: req,
    recalledMemories: memories,
    memorySource: memory.source,
    recallQuery,
    memoryUsage,
    draft: decision.action,
    llmMode: llm.mode,
    retainedMemoryIds: [],
    learning: {
      observationsConsidered,
      mentalModelSnapshot,
    },
    decision,
  };
  await getRunStore().save(run);
  return run;
}

/**
 * Stages 5+6: OUTCOME → RETAIN → CONSOLIDATE.
 * The outcome becomes (a) episodic memory via retain and (b) evidence for the
 * observation consolidation engine, which updates beliefs + mental model.
 * Returns the run with its learning delta attached.
 */
export async function handleOutcomeReport(
  runId: string,
  report: { outcome: OutcomeReport["outcome"]; feedback?: string }
): Promise<DraftRun> {
  const store = getRunStore();
  const run = await store.get(runId);
  if (!run) throw new Error(`run not found: ${runId}`);

  run.outcome = {
    outcome: report.outcome,
    feedback: report.feedback,
    reportedAt: new Date().toISOString(),
  };

  const memory = overrides.memory ?? getMemoryProvider();

  // (a) Episodic retain — what happened, as experience.
  const retained: RetainedMemory[] = buildOutcomeMemory({
    account: run.request.account,
    draft: run.draft,
    outcome: report.outcome,
    feedback: report.feedback,
    memoryUsage: run.memoryUsage,
    runId: run.runId,
  });
  let ids: string[] = [];
  let learningNote = "";
  try {
    ids = await memory.retain(retained);
  } catch (err) {
    // Transient memory outage must not destroy the judge's run: the outcome is
    // already recorded and consolidation (deterministic, local) still runs —
    // future behavior still changes at the belief layer. The run carries a
    // TRUTHFUL degraded note instead of a fake success or a hard error.
    console.error("[orchestrator] retain failed (consolidation continues):", err);
    learningNote =
      "Memory write to Hindsight failed transiently — the outcome was recorded and beliefs were still updated, but this experience may not be recallable later. Report the outcome again to retry.";
  }

  // (b) Consolidate — pattern detection over this account's outcome evidence.
  const evidence = evidenceFromOutcome({
    runId: run.runId,
    account: run.request.account,
    draftSubject: run.draft.subject,
    strategyLabels: run.draft.strategyLabels,
    outcome: report.outcome,
    feedback: report.feedback,
    memoryIds: ids,
    occurredAt: run.outcome.reportedAt,
  });

  const existing = await memory.listObservations(run.request.account.accountId);
  const { observations, delta } = consolidate([evidence], existing);
  try {
    await memory.saveObservations(observations);
  } catch (err) {
    // Belief persistence is critical (it IS the learned state). Unlike a
    // transient retain outage, silently continuing here would fake learning.
    console.error("[orchestrator] saveObservations failed:", err);
    throw new Error(
      `consolidation persistence failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  run.retainedMemoryIds = ids;

  // Stage 8+9: refresh the mental model AFTER consolidation and record the
  // human-readable before/after so the audit trail shows exactly how this
  // outcome changed what the agent believes.
  let afterModel: AccountMentalModel | undefined;
  try {
    afterModel = (await memory.getAccountMentalModel(run.request.account.accountId)).model;
  } catch (err) {
    console.error("[orchestrator] post-outcome mental model refresh failed:", err);
  }
  const beforeBeliefs = run.learning?.mentalModelSnapshot?.beliefs ?? [];
  const beforeLines = beforeBeliefs.length
    ? beforeBeliefs.map((b) => `${b.statement} [confidence ${b.confidence.toFixed(2)}, ${b.evidenceCount} evidence]`)
    : ["(no consolidated beliefs — the agent had no learned knowledge of this account)"];
  const afterLines = afterModel?.beliefs.length
    ? [
        ...afterModel.beliefs.map(
          (b) => `${b.statement} [confidence ${b.confidence.toFixed(2)}, ${b.evidenceCount} evidence]`
        ),
        ...(afterModel.approachesToAvoid.length
          ? [`Now avoids: ${afterModel.approachesToAvoid.join(" | ")}`]
          : []),
        ...(afterModel.approachesToRepeat.length
          ? [`Now repeats: ${afterModel.approachesToRepeat.join(" | ")}`]
          : []),
      ]
    : ["(no consolidated beliefs)"];

  run.learning = {
    observationsConsidered: run.learning?.observationsConsidered ?? [],
    mentalModelSnapshot: run.learning?.mentalModelSnapshot,
    learningDelta: {
      ...delta,
      // Truthful degraded state: if the Hindsight write failed transiently,
      // the audit trail says so instead of implying the experience was stored.
      mentalModelNote: learningNote || delta.mentalModelNote,
    },
  };
  run.beforeAfter = { before: beforeLines, after: afterLines };
  await store.save(run);
  return run;
}

/**
 * Parse + validate the plan; drop hallucinated references. Usage claims must
 * reference memories/observations actually provided (audit integrity).
 * Exported for adversarial provenance tests: this is the enforcement point
 * for "a factor must trace to knowledge actually served to the agent this run".
 */
export function draftFromPlan(
  planJson: string,
  memories: RecalledMemory[],
  observations: Observation[]
): {
  plan: { subject: string; body: string; strategyLabels?: string[] };
  memoryUsage: MemoryUsage[];
  observationUsage: ObservationUsage[];
  decisionFields: {
    selectedStrategy?: string;
    reasoningFactors: DecisionFactor[];
    confidence?: number;
    expectedOutcome?: string;
  };
} {
  const cleaned = planJson.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  let parsed: {
    subject?: string;
    body?: string;
    strategyLabels?: string[];
    memoryUsage?: MemoryUsage[];
    observationUsage?: Array<{ observationId: string; influence: string }>;
    selectedStrategy?: string;
    reasoningFactors?: DecisionFactor[];
    confidence?: number;
    expectedOutcome?: string;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned non-JSON plan: ${cleaned.slice(0, 200)}`);
  }
  if (!parsed.subject || !parsed.body) {
    throw new Error(`LLM plan missing subject/body: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  const knownMemoryIds = new Set(memories.map((m) => m.id));
  const memoryUsage = (parsed.memoryUsage ?? []).filter((u) => knownMemoryIds.has(u.memoryId));

  const byId = new Map(observations.map((o) => [o.id, o]));
  const observationUsage = (parsed.observationUsage ?? [])
    .filter((u) => byId.has(u.observationId))
    .map((u) => {
      const obs = byId.get(u.observationId)!;
      return {
        observationId: obs.id,
        statement: obs.statement,
        confidence: obs.confidence,
        influence: u.influence,
      };
    });

  // Decision factors: keep only factors whose provenance resolves to knowledge
  // actually provided this run (audit integrity — no invented references).
  const DIRECTIONS = new Set(["pushed toward", "pushed against", "uncertainty"] as const);
  const reasoningFactors = (parsed.reasoningFactors ?? []).filter((f) => {
    if (!f || typeof f.statement !== "string" || f.statement.length === 0) return false;
    if (!DIRECTIONS.has(f.direction)) return false;
    if (f.source === "situation") return true;
    if (f.source === "memory") return typeof f.refId === "string" && knownMemoryIds.has(f.refId);
    if (f.source === "observation") return typeof f.refId === "string" && byId.has(f.refId);
    return false;
  });
  const confidence =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : undefined;

  return {
    plan: parsed as { subject: string; body: string; strategyLabels?: string[] },
    memoryUsage,
    observationUsage,
    decisionFields: {
      selectedStrategy: parsed.selectedStrategy,
      reasoningFactors,
      confidence,
      expectedOutcome: parsed.expectedOutcome,
    },
  };
}
