import type {
  AccountContext,
  AccountMentalModel,
  LearningDelta,
  MemoryEvidence,
  Observation,
  ObservationStatus,
  OutcomeResult,
  RecalledMemory,
} from "../types";
import { outcomeValence } from "../types";

/**
 * Observation consolidation — the pattern-detection layer.
 *
 * Pure and deterministic: same evidence → same observation. No LLM calls, so
 * the learning layer never depends on an LLM being available (constraint 14).
 *
 * BELIEF SEMANTICS (kept minimal and coherent):
 * Every observation is a FRICTION belief: "this account shows friction around
 * dimension D". That orientation matters:
 *   - evidence SUPPORTS the belief when an outcome went badly while D was in
 *     play (negative valence mentioning D), or when AE feedback names D as the
 *     problem on any outcome;
 *   - evidence CONTRADICTS the belief when an outcome went well while D was in
 *     play without feedback naming D as a problem (success with pricing on the
 *     table is evidence the account is NOT strictly price-blocked);
 *   - contradictions are represented (status "contested"), never silently
 *     reinforced or discarded; the belief is retired when negatives dominate.
 *
 * Grounding rules (enforced, not aspirational):
 * - A single supporting example creates only a LOW-confidence, "contested"
 *   belief — never an active one. MIN_EVIDENCE supporting pieces are required
 *   for "active"; the statement itself marks single-example beliefs as
 *   unconfirmed so nothing overstates what one outcome shows.
 * - Confidence is evidence-weighted with diminishing returns and a cap, so
 *   beliefs stay revisable.
 * - Detection is lexicon-based over the AE's own words — nothing is invented.
 */

/** Supporting evidence needed for a belief to be ACTIVE (grounding floor). */
export const MIN_EVIDENCE = 2;

const DIMINISHING = 0.85; // each additional piece of evidence adds less than the last
const CONF_CAP = 0.9; // beliefs stay revisable; nothing is ever "certain"

export const DIMENSIONS = ["pricing", "security", "timing", "channel", "messaging"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_LEXICON: Record<Dimension, string[]> = {
  pricing: ["pricing", "price", "budget", "cost", "expensive", "discount", "too aggressive", "premium", "cheaper", "quote"],
  security: ["security", "soc 2", "soc2", "compliance", "hipaa", "gdpr", "penetration", "pen test", "vendor review", "infosec"],
  timing: ["timing", "too early", "too soon", "quarter", "fiscal", "cycle", "delay", "postpone", "revisit"],
  channel: ["email", "call", "voicemail", "linkedin", "channel", "outreach", "sequence", "phone"],
  messaging: ["messaging", "wording", "tone", "copy", "phrasing", "positioning", "pitch", "angle", "subject line"],
};

/** Does the text mention this dimension? (deterministic lexicon match) */
export function detectDimensions(text: string): Dimension[] {
  const t = text.toLowerCase();
  return DIMENSIONS.filter((d) => DIMENSION_LEXICON[d].some((k) => t.includes(k)));
}

/** Build an evidence record from an outcome being consolidated. */
export function evidenceFromOutcome(input: {
  runId: string;
  account: AccountContext;
  draftSubject: string;
  strategyLabels: string[];
  outcome: OutcomeResult;
  feedback?: string;
  memoryIds: string[];
  occurredAt: string;
}): MemoryEvidence {
  const { runId, account, draftSubject, strategyLabels, outcome, feedback, memoryIds, occurredAt } = input;
  return {
    runId,
    memoryId: memoryIds[0],
    summary:
      `Follow-up "${draftSubject}" to ${account.contactName} (${account.contactRole}) at ${account.company}` +
      ` → ${outcome.replace("_", " ")}` +
      (feedback ? `; feedback: "${feedback}"` : ""),
    outcome,
    valence: outcomeValence(outcome),
    feedback,
    occurredAt,
    accountId: account.accountId,
    strategyLabels,
  };
}

/**
 * Extract evidence from recalled episodic memories (the OUTCOME step's recall).
 * Outcome memories are those tagged "outcome" with an outcome in metadata
 * (see buildOutcomeMemory).
 */
export function extractEvidenceFromRecall(recalled: RecalledMemory[], accountId: string): MemoryEvidence[] {
  const out: MemoryEvidence[] = [];
  for (const m of recalled) {
    if (!(m.tags ?? []).includes("outcome")) continue;
    const outcome = m.metadata?.outcome as OutcomeResult | undefined;
    if (!outcome) continue;
    const feedbackMatch = /AE feedback:\s*([^.;]+)/.exec(m.text);
    out.push({
      runId: m.metadata?.runId ?? "unknown",
      memoryId: m.id,
      summary: m.text,
      outcome,
      valence: outcomeValence(outcome),
      feedback: feedbackMatch?.[1]?.trim(),
      occurredAt: m.occurredAt ?? new Date().toISOString(),
      accountId: m.metadata?.accountId ?? accountId,
      strategyLabels: [],
    });
  }
  return out;
}

/** Weighted confidence from evidence counts, diminishing returns, capped. */
export function confidenceFor(support: number, against: number): number {
  if (support === 0) return 0;
  let conf = 0;
  for (let i = 0; i < support; i++) {
    conf += Math.pow(DIMINISHING, i) * 0.4;
  }
  const penalty = against > 0 ? Math.min(0.3 * against, 0.6) : 0;
  return Math.max(0, Math.min(CONF_CAP, conf - penalty));
}

/** Stable pattern key: observations group by this across outcomes. */
export function patternKeyFor(dimension: string, accountId: string): string {
  return `${dimension}@${accountId}`;
}

/** Does feedback text indicate the dimension itself was the problem? */
function feedbackBlamesDimension(dim: Dimension, feedback: string): boolean {
  // Clause-level co-occurrence: the dimension keyword and a blame marker must
  // appear in the SAME clause. Whole-text matching mis-attributes blame —
  // e.g. "pricing is too aggressive; lead with the security review win"
  // blames pricing but DIRECTS the agent toward security, not away from it.
  const clauses = feedback
    .toLowerCase()
    .split(/[;.\n,]|\band\b/)
    .map((c) => c.trim())
    .filter(Boolean);
  return clauses.some((clause) => {
    if (!DIMENSION_LEXICON[dim].some((k) => clause.includes(k))) return false;
    // Unambiguous blame markers only. Deliberately EXCLUDES "lead with X":
    // in AE feedback that is a directive to USE the dimension, not blame it.
    const negative = ["too", "avoid", "aggressive", "wrong", "bad", "failed", "rejection", "reject", "stalled", "silence", "no reply", "pushback", "sensitive"];
    return negative.some((n) => clause.includes(n));
  });
}

/**
 * Classify one piece of evidence for a dimension:
 * - "support": friction signal (belief strengthened)
 * - "against": success signal (belief contradicted)
 * - null:      not evidence either way for this dimension
 */
export function classifyEvidence(ev: MemoryEvidence, dim: Dimension): "support" | "against" | null {
  // The approach itself counts as "the dimension being in play": a draft
  // labeled defer-pricing that failed (or succeeded) is pricing evidence even
  // when the AE feedback is silent.
  const text = `${ev.summary} ${ev.feedback ?? ""} ${ev.strategyLabels.join(" ")}`.toLowerCase();
  const mentions = DIMENSION_LEXICON[dim].some((k) => text.includes(k));
  if (!mentions) return null;

  if (ev.feedback && feedbackBlamesDimension(dim, ev.feedback)) return "support";
  if (ev.valence === "negative") return "support";
  // Positive outcome with no blaming feedback: success while D was in play.
  return "against";
}

/** Statement derives ONLY from recorded evidence facts — never invented. */
function statementFor(dim: Dimension, support: MemoryEvidence[], against: MemoryEvidence[]): string {
  const accountId = support[0]?.accountId ?? against[0]?.accountId ?? "unknown";
  const topic: Record<Dimension, string> = {
    pricing: "price/budget sensitivity",
    security: "security & compliance review requirements",
    timing: "buying-cycle timing",
    channel: "preferred outreach channel",
    messaging: "messaging/positioning preferences",
  };
  const pos = support.length;
  const neg = against.length;
  const recurring = pos >= 2; // wording strength follows the grounding floor
  if (neg === 0) {
    return (
      `Account ${accountId}: ${recurring ? "recurring friction" : "possible friction"} around ${topic[dim]} — ` +
      `${pos} independent outcome${pos === 1 ? "" : "s"} where approaches tied to this dimension underperformed ` +
      `(${support.map((e) => e.outcome.replace("_", " ")).join(", ")})` +
      (recurring ? "." : "; single example — treat as unconfirmed." )
    );
  }
  if (pos === 0) {
    return (
      `Account ${accountId}: prior friction around ${topic[dim]} now contradicted by ` +
      `${neg} successful outcome${neg === 1 ? "" : "s"} while this dimension was in play.`
    );
  }
  if (neg > pos) {
    return (
      `Account ${accountId}: earlier friction around ${topic[dim]} is outweighed by ` +
      `${neg} successful outcome${neg === 1 ? "" : "s"} (vs ${pos} friction signal${pos === 1 ? "" : "s"}) — ` +
      `treat the friction belief as superseded and verify before assuming friction.`
    );
  }
  return (
    `Account ${accountId}: mixed evidence on ${topic[dim]} — ${pos} friction signal${pos === 1 ? "" : "s"} vs ` +
    `${neg} success signal${neg === 1 ? "" : "s"}; treat as unresolved and verify directly.`
  );
}

/**
 * The complete consolidation step: new evidence + existing observations →
 * updated observation set + a delta describing exactly what changed.
 */
export function consolidate(evidence: MemoryEvidence[], existing: Observation[]): {
  observations: Observation[];
  delta: LearningDelta;
} {
  const now = new Date().toISOString();
  const created: Observation[] = [];
  const updated: LearningDelta["observationsUpdated"] = [];

  const byKey = new Map<string, Observation>();
  for (const obs of existing) byKey.set(obs.patternKey, obs);

  // Classify the new evidence per dimension.
  const groups = new Map<string, { support: MemoryEvidence[]; against: MemoryEvidence[]; accountId: string }>();
  for (const ev of evidence) {
    for (const dim of DIMENSIONS) {
      const kind = classifyEvidence(ev, dim);
      if (!kind) continue;
      const key = patternKeyFor(dim, ev.accountId);
      const g = groups.get(key) ?? { support: [], against: [], accountId: ev.accountId };
      g[kind].push(ev);
      groups.set(key, g);
    }
  }

  for (const [key, g] of groups) {
    const prev = byKey.get(key);
    const dimension = key.split("@")[0] as Dimension;

    // Merge with evidence already on the observation (if updating).
    const support = [...(prev?.supportingEvidence ?? []), ...g.support];
    const against = [...(prev?.contradictingEvidence ?? []), ...g.against];

    if (!prev && support.length === 0) {
      // Never invent a NEW friction belief from success alone.
      continue;
    }

    const conf = confidenceFor(support.length, against.length);
    let status: ObservationStatus;
    if (support.length === 0) {
      // Only contradictions: the belief as previously stated does not hold.
      // If there was a previous belief, mark it contested/retired; never
      // invent a NEW friction belief from success alone.
      if (!prev) continue;
      status = against.length >= MIN_EVIDENCE ? "retired" : "contested";
    } else if (against.length >= MIN_EVIDENCE && against.length > support.length) {
      // Negatives dominate the carried-forward evidence: the belief no longer
      // holds. Retired, not deleted — the audit trail keeps the full history.
      status = "retired";
    } else if (against.length > 0) {
      status = "contested";
    } else if (support.length < MIN_EVIDENCE) {
      // Below the grounding floor: belief exists but stays weak/uncertain —
      // a single example can never harden into an active belief.
      status = "contested";
    } else {
      status = "active";
    }

    const obs: Observation = {
      id: prev?.id ?? `obs_${crypto.randomUUID()}`,
      accountId: g.accountId,
      statement: statementFor(dimension, support, against),
      confidence: conf,
      supportingEvidence: support,
      contradictingEvidence: against,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      status,
      sourceMemoryIds: [
        ...new Set(
          [...support, ...against]
            .map((e) => e.memoryId)
            .filter((x): x is string => Boolean(x))
        ),
      ],
      patternKey: key,
      tags: [dimension, g.accountId],
    };

    byKey.set(key, obs);
    if (prev) {
      updated.push({
        observationId: prev.id,
        before: { confidence: prev.confidence, status: prev.status },
        beforeConfidence: prev.confidence,
        afterConfidence: conf,
        afterStatus: status,
      });
    } else {
      created.push(obs);
    }
  }

  const observations = [...byKey.values()];
  const delta: LearningDelta = {
    observationsCreated: created,
    observationsUpdated: updated,
    mentalModelNote: created.length
      ? `New belief formed: "${created[0].statement}" (confidence ${created[0].confidence.toFixed(2)}, from ${created[0].supportingEvidence.length} outcome${created[0].supportingEvidence.length === 1 ? "" : "s"}).`
      : updated.length
        ? `Belief "${updated[0].observationId}" updated from this outcome: confidence ${updated[0].beforeConfidence.toFixed(2)} → ${updated[0].afterConfidence.toFixed(2)}, status → ${updated[0].afterStatus}.`
        : "No pattern crossed the evidence floor this round.",
    consolidatedAt: now,
  };
  return { observations, delta };
}

/**
 * Build the account mental model from current observations.
 * Deterministic; answers "what should I already know before acting?".
 */
export function buildMentalModel(accountId: string, observations: Observation[]): AccountMentalModel {
  const active = observations.filter((o) => o.status !== "retired");
  return {
    accountId,
    generatedAt: new Date().toISOString(),
    beliefs: active.map((o) => ({
      statement: o.statement,
      confidence: o.confidence,
      evidenceCount: o.supportingEvidence.length + o.contradictingEvidence.length,
    })),
    uncertainties: active
      .filter((o) => o.status === "contested" || o.confidence < 0.5)
      .map((o) => `Unresolved: ${o.statement} (confidence ${o.confidence.toFixed(2)}; verify with the account)`),
    // Observations are FRICTION beliefs, so evidence orientation is:
    //   supportingEvidence  = outcomes where approaches tied to this dimension
    //                         UNDERPERFORMED → their strategies should be avoided
    //   contradictingEvidence = successes in play → their strategies worked
    approachesToRepeat: active
      .filter((o) => o.status !== "retired")
      .flatMap((o) => {
        const worked = o.contradictingEvidence.flatMap((e) => e.strategyLabels);
        return worked.length
          ? [`${dimensionLabel(o)} — succeeded via: ${[...new Set(worked)].join(", ")}`]
          : [];
      }),
    approachesToAvoid: active
      .flatMap((o) => {
        const failed = o.supportingEvidence.flatMap((e) => e.strategyLabels);
        return failed.length
          ? [`${dimensionLabel(o)} — friction seen via: ${[...new Set(failed)].join(", ")}`]
          : [];
      }),
    observationIds: active.map((o) => o.id),
  };
}

function dimensionLabel(o: Observation): string {
  return o.patternKey.split("@")[0] ?? o.statement;
}

/** Render observations + mental model as prompt sections. */
export function renderLearningSections(input: {
  observations: Observation[];
  mentalModel: AccountMentalModel;
}): string {
  const { observations, mentalModel } = input;
  // The observation id is rendered so both the mock LLM and live models can
  // reference it back in observationUsage (validated against known ids).
  const obsLines = observations.length
    ? observations
        .map(
          (o) =>
            `- [${o.status}] (id=${o.id}, confidence ${o.confidence.toFixed(2)}, evidence: ${o.supportingEvidence.length} supporting / ${o.contradictingEvidence.length} contradicting) ${o.statement}`
        )
        .join("\n")
    : "(none yet — no consolidated beliefs for this account)";

  const mm = mentalModel;
  const mmLines = [
    `Beliefs:`,
    ...(mm.beliefs.length
      ? mm.beliefs.map((b) => `  • ${b.statement} [confidence ${b.confidence.toFixed(2)}, ${b.evidenceCount} evidence items]`)
      : ["  • (none)"]),
    `Uncertainties: ${mm.uncertainties.length ? mm.uncertainties.join(" | ") : "(none)"}`,
    `Approaches to repeat: ${mm.approachesToRepeat.length ? mm.approachesToRepeat.join(" | ") : "(none yet)"}`,
    `Approaches to avoid: ${mm.approachesToAvoid.length ? mm.approachesToAvoid.join(" | ") : "(none yet)"}`,
  ].join("\n");

  return obsLines + "\n" + mmLines;
}
