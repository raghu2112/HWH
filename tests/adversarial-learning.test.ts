import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnv } from "@/lib/config/env";
import { resetMemoryProvider, getMemoryProvider } from "@/lib/memory/factory";
import { resetLLMProvider } from "@/lib/llm/factory";
import { resetRunStore } from "@/lib/store/runs";
import { resetObservationStore } from "@/lib/store/observations";
import { handleDraftRequest, handleOutcomeReport, draftFromPlan } from "@/lib/agent/orchestrator";
import type {
  AccountContext,
  DraftRequest,
  Observation,
  RecalledMemory,
} from "@/lib/types";

/**
 * Adversarial learning scenarios: stress whether the product demonstrates
 * LEARNING (PAST EXPERIENCE → OUTCOME → CONSOLIDATION → BELIEF → MENTAL MODEL
 * → FUTURE DECISION) rather than RAG, conversation history, a CRUD memory
 * store, or a static rule engine.
 *
 * All scenarios run the REAL orchestrator with the REAL local provider and the
 * REAL mock LLM in an isolated data dir — no fixtures are injected into the
 * decision path.
 */

function makeDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hwh-adversarial-"));
}

let dataDir: string;

const ACME: AccountContext = {
  accountId: "acme",
  company: "Acme",
  contactName: "Jane Doe",
  contactRole: "CTO",
  situationNotes: "Trial expiring; champion quiet since the security questionnaire.",
};

function req(account: AccountContext = ACME, goal = "re-engage after silence"): DraftRequest {
  return { account, goal };
}

async function freshOrchestrator(): Promise<void> {
  resetEnv();
  delete process.env.HINDSIGHT_API_KEY;
  delete process.env.GROQ_API_KEY;
  dataDir = makeDataDir();
  process.env.DATA_DIR = dataDir;
  resetEnv();
  resetMemoryProvider();
  resetLLMProvider();
  resetRunStore();
  resetObservationStore();
}

describe("Scenario A — negative learning (failure changes future behavior)", () => {
  beforeEach(freshOrchestrator);

  it("a failed generic check-in is retained, consolidated, and avoided next time", async () => {
    // RUN 1: the agent has no experience and acts generically.
    const run1 = await handleDraftRequest(req(ACME, "generic check-in"));
    expect(run1.decision!.selectedStrategy).toContain("Generic first-touch");
    expect(run1.learning!.observationsConsidered).toEqual([]);

    // OUTCOME: no reply, AE explains why.
    const withOutcome = await handleOutcomeReport(run1.runId, {
      outcome: "no_reply",
      feedback: "Pricing was introduced too early.",
    });

    // The evidence is retained into episodic memory…
    expect(withOutcome.retainedMemoryIds.length).toBeGreaterThan(0);
    // …and consolidated into an evidence-backed belief (not just a stored memory).
    const delta = withOutcome.learning!.learningDelta!;
    expect(delta.observationsCreated.map((o) => o.patternKey)).toContain("pricing@acme");
    expect(delta.mentalModelNote).toContain("New belief");

    // RUN 2: the decision must change because of the learned belief.
    const run2 = await handleDraftRequest(req(ACME, "generic check-in"));
    const d2 = run2.decision!;
    expect(run2.recalledMemories.length).toBeGreaterThan(0); // it remembers
    expect(d2.selectedStrategy).not.toContain("Generic first-touch"); // …and behaves differently
    expect(run2.draft.strategyLabels).not.toEqual(run1.draft.strategyLabels);
    // The learned mistake becomes an explicit constraint, not a vague memory.
    expect(d2.constraints.join(" ").toLowerCase()).toContain("pricing");
    // The strategy change is causally attributed to the learned belief.
    expect(d2.reasoningFactors.some((f) => f.source === "observation")).toBe(true);
  });
});

describe("Scenario B — repeated negative evidence hardens the belief", () => {
  beforeEach(freshOrchestrator);

  it("a second failure on the same dimension crosses the grounding floor into an active constraint", async () => {
    const r1 = await handleDraftRequest(req(ACME, "follow up with a pricing-led ask"));
    await handleOutcomeReport(r1.runId, {
      outcome: "no_reply",
      feedback: "pricing was introduced too early",
    });

    // One example → weak, unconfirmed belief.
    const mid = await handleDraftRequest(req(ACME));
    const weak = mid.learning!.observationsConsidered.find((o) => o.statement.includes("price"));
    expect(weak).toBeDefined();
    expect(weak!.confidence).toBeLessThan(0.5);

    // Second failed cycle on the same dimension.
    const r1b = await handleDraftRequest(req(ACME, "follow up with another pricing-led ask"));
    await handleOutcomeReport(r1b.runId, {
      outcome: "no_reply",
      feedback: "pricing was too aggressive again",
    });

    // The belief is now established per the existing consolidation rules…
    const run3 = await handleDraftRequest(req(ACME));
    const belief = run3.learning!.observationsConsidered.find((o) => o.statement.includes("price"));
    expect(belief).toBeDefined();
    expect(belief!.confidence).toBeGreaterThanOrEqual(0.7);
    // …and the decision treats it as a binding constraint, not a vague memory:
    expect(run3.decision!.constraints.join(" ")).toContain("pricing");
    expect(run3.decision!.beliefsConsulted).toContain(belief!.observationId);
    expect(run3.decision!.selectedStrategy).not.toContain("Generic");
    // …and it does not repeat the failing approach.
    expect(run3.draft.strategyLabels).not.toContain("generic-first-touch");
  });
});

describe("Scenario C — contradiction is represented, never erased", () => {
  beforeEach(freshOrchestrator);

  it("success evidence contests the belief; all history stays inspectable; the next decision carries the conflict", async () => {
    // Establish an ACTIVE pricing-friction belief (two independent failures).
    const r1 = await handleDraftRequest(req(ACME, "send the pricing sheet"));
    await handleOutcomeReport(r1.runId, { outcome: "no_reply", feedback: "pricing was too aggressive" });
    const r1b = await handleDraftRequest(req(ACME, "send the pricing sheet again"));
    await handleOutcomeReport(r1b.runId, { outcome: "no_reply", feedback: "pricing still too aggressive" });

    const provider = getMemoryProvider();
    const before = (await provider.listObservations("acme")).find(
      (o) => o.patternKey === "pricing@acme"
    )!;
    expect(before.status).toBe("active");
    const historyBefore = before.supportingEvidence.map((e) => e.runId);

    // CONTRADICTION: pricing discussed early → meeting booked.
    const r2 = await handleDraftRequest(req(ACME, "they asked for pricing; send it early"));
    await handleOutcomeReport(r2.runId, {
      outcome: "meeting_booked",
      feedback: "they engaged immediately once pricing was on the table",
    });

    const after = (await provider.listObservations("acme")).find(
      (o) => o.patternKey === "pricing@acme"
    )!;
    // NOT deleted and NOT recreated: same belief object, same creation date.
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    // The full evidence history remains inspectable…
    expect(after.supportingEvidence.map((e) => e.runId)).toEqual(historyBefore);
    // …with the contradicting outcome recorded alongside it.
    expect(after.contradictingEvidence.length).toBe(1);
    expect(after.contradictingEvidence[0].outcome).toBe("meeting_booked");
    expect(after.status).toBe("contested"); // per existing rules: conflict, not erasure
    expect(after.statement).toContain("mixed evidence");

    // The next decision does NOT blindly follow the old belief…
    const run3 = await handleDraftRequest(req(ACME));
    const d3 = run3.decision!;
    expect(d3.uncertainties.length).toBeGreaterThan(0);
    expect(d3.reasoningFactors.some((f) => f.direction === "uncertainty")).toBe(true);
    expect(d3.confidence).toBeLessThan(0.5); // confidence drops under conflict
    expect(run3.draft.strategyLabels).toContain("acknowledge-contradiction");
    // …and the audit trail shows exactly which evidence conflicted.
    const considered = run3.learning!.observationsConsidered.find(
      (u) => u.observationId === after.id
    )!;
    expect(considered.influence).toContain("contradict");
  });
});

describe("Scenario D — cross-account isolation of learning", () => {
  beforeEach(freshOrchestrator);

  it("A's belief never influences B; B's success never weakens A's belief", async () => {
    // Account A learns pricing friction (two failed cycles → active belief).
    const a1 = await handleDraftRequest(req(ACME, "pricing-led follow-up"));
    await handleOutcomeReport(a1.runId, { outcome: "no_reply", feedback: "pricing was too aggressive" });
    const a2 = await handleDraftRequest(req(ACME, "pricing-led follow-up"));
    await handleOutcomeReport(a2.runId, { outcome: "no_reply", feedback: "pricing still too aggressive" });

    // Account B: fresh account whose pricing-led interaction SUCCEEDS.
    const B: AccountContext = {
      ...ACME,
      accountId: "initech",
      company: "Initech",
      contactName: "Bob Brown",
      contactRole: "CFO",
    };
    const b1 = await handleDraftRequest(req(B, "share pricing"));
    // B starts clean: no recall, no beliefs from A's account.
    expect(b1.recalledMemories).toEqual([]);
    expect(b1.learning!.observationsConsidered).toEqual([]);
    expect(b1.decision!.selectedStrategy).toContain("Generic first-touch");

    await handleOutcomeReport(b1.runId, {
      outcome: "meeting_booked",
      feedback: "pricing landed well",
    });

    const provider = getMemoryProvider();
    // B's success NEVER entered A's evidence ledger…
    const aPricing = (await provider.listObservations("acme")).find(
      (o) => o.patternKey === "pricing@acme"
    )!;
    expect(aPricing.contradictingEvidence.length).toBe(0);
    expect(aPricing.status).toBe("active");
    // …and success alone never invents a belief in B's ledger.
    expect(await provider.listObservations("initech")).toEqual([]);

    // A's next decision still consults only A's beliefs, with account-specific provenance.
    const a3 = await handleDraftRequest(req(ACME));
    const beliefIds = new Set(a3.learning!.observationsConsidered.map((u) => u.observationId));
    expect(a3.learning!.observationsConsidered.length).toBeGreaterThan(0);
    for (const f of a3.decision!.reasoningFactors) {
      if (f.source === "observation") expect(beliefIds.has(f.refId!)).toBe(true);
      if (f.source === "memory") {
        const mem = a3.recalledMemories.find((m) => m.id === f.refId);
        expect(mem?.metadata?.accountId ?? mem?.tags?.[0]).toBe("acme");
      }
    }
    expect(
      a3.recalledMemories.every(
        (m) => (m.tags ?? []).includes("acme") || m.metadata?.accountId === "acme"
      )
    ).toBe(true);
  });
});

describe("Scenario E — irrelevant memory must not become a reasoning factor", () => {
  beforeEach(freshOrchestrator);

  it("a retained-but-unrelated memory is stored but never served into the decision", async () => {
    // Baseline decision on a clean store.
    const baseline = await handleDraftRequest(req(ACME));

    // Retain a strong-but-unrelated memory for the same account (account scope
    // via metadata; deliberately no content keyword overlap with the request).
    const provider = getMemoryProvider();
    await provider.retain([
      {
        content:
          "Annual company picnic planning notes: catering quotes reviewed and venue booked for June.",
        context: "unrelated operations detail",
        tags: [],
        metadata: { accountId: "acme" },
      },
    ]);

    // It EXISTS in the memory system…
    const found = await provider.recall({
      account: { ...ACME, company: "picnic catering venue booking" },
      goal: "annual company picnic",
    });
    expect(found.length).toBeGreaterThan(0);

    // …but it is not relevant to the current situation, so it must not be
    // served to the decision at all.
    const run = await handleDraftRequest(req(ACME));
    expect(run.recalledMemories.length).toBe(0);
    expect(run.memoryUsage).toEqual([]);
    // Provenance prevents hallucinated usage: the decision is byte-identical
    // to the clean-store baseline — zero influence, zero invented factors.
    expect(run.decision).toEqual(baseline.decision);
    expect(run.draft).toEqual(baseline.draft);
  });
});

describe("Scenario F — a single weak example yields uncertainty, not fact-like behavior", () => {
  beforeEach(freshOrchestrator);

  it("one weak negative example stays low-confidence, explicitly unconfirmed, and uncertainty-carrying", async () => {
    const r1 = await handleDraftRequest(req(ACME));
    await handleOutcomeReport(r1.runId, { outcome: "no_reply", feedback: "pricing felt premature" });

    const run2 = await handleDraftRequest(req(ACME));
    const belief = run2.learning!.observationsConsidered.find((o) => o.statement.includes("price"))!;

    // The belief exists but is held below the grounding floor…
    expect(belief.confidence).toBeLessThan(0.5);
    // …and its statement marks it unconfirmed rather than established.
    expect(belief.statement).toContain("unconfirmed");
    // The decision REPRESENTS the uncertainty instead of acting on a "fact".
    expect(run2.decision!.uncertainties.length).toBeGreaterThan(0);
    expect(run2.decision!.reasoningFactors.some((f) => f.direction === "uncertainty")).toBe(true);
    // Confidence stays below what an ESTABLISHED belief would earn (0.65) —
    // appropriately low for a single example, not fact-like.
    expect(run2.decision!.confidence).toBeLessThan(0.65);
    // Strategy holds the belief loosely (probe), it does not reorganize around it.
    expect(run2.draft.strategyLabels).toContain("hold-lightly");
    expect(run2.draft.strategyLabels).not.toContain("defer-pricing");
  });
});

describe("Phase 3 — provenance integrity: invalid references are rejected, not stored", () => {
  const servedMemories: RecalledMemory[] = [
    {
      id: "mem_served",
      text: "Follow-up sent. Outcome: no_reply.",
      type: "world",
      tags: ["acme"],
      metadata: { accountId: "acme" },
    },
  ];
  const servedObservations: Observation[] = [
    {
      id: "obs_served",
      accountId: "acme",
      statement: "Account acme: recurring friction around price/budget sensitivity.",
      confidence: 0.74,
      supportingEvidence: [],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      sourceMemoryIds: [],
      patternKey: "pricing@acme",
      tags: ["pricing", "acme"],
    },
  ];

  function factors(raw: unknown) {
    return draftFromPlan(
      JSON.stringify({ subject: "s", body: "b", reasoningFactors: raw }),
      servedMemories,
      servedObservations
    ).decisionFields.reasoningFactors;
  }

  it("drops factors referencing an invented memory id", () => {
    const kept = factors([
      { source: "memory", refId: "mem_invented", statement: "x", direction: "pushed toward" },
      { source: "memory", refId: "mem_served", statement: "y", direction: "pushed toward" },
    ]);
    expect(kept.map((f) => f.refId)).toEqual(["mem_served"]);
  });

  it("drops factors referencing an observation that was not recalled this run", () => {
    const kept = factors([
      { source: "observation", refId: "obs_never_served", statement: "x", direction: "uncertainty" },
      { source: "observation", refId: "obs_served", statement: "y", direction: "uncertainty" },
    ]);
    expect(kept.map((f) => f.refId)).toEqual(["obs_served"]);
  });

  it("drops cross-account references: another account's memory id is not servable here", () => {
    // The id exists conceptually "in storage" for a different account — it is
    // still not part of THIS run's served knowledge, so it must be dropped.
    const kept = factors([
      { source: "memory", refId: "local_foreign-account-id", statement: "x", direction: "pushed toward" },
      { source: "observation", refId: "obs_other-account", statement: "y", direction: "pushed toward" },
    ]);
    expect(kept).toEqual([]);
  });

  it("drops factors with unknown directions or empty statements", () => {
    const kept = factors([
      { source: "situation", statement: "", direction: "pushed toward" },
      { source: "situation", statement: "invented direction", direction: "vibes" },
      { source: "memory", statement: "no refId", direction: "pushed toward" },
      { source: "situation", statement: "kept", direction: "uncertainty" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].statement).toBe("kept");
  });

  it("drops memoryUsage entries with invented ids", () => {
    const { memoryUsage } = draftFromPlan(
      JSON.stringify({
        subject: "s",
        body: "b",
        memoryUsage: [
          { memoryId: "mem_invented", relevance: "r", effect: "e" },
          { memoryId: "mem_served", relevance: "r", effect: "e" },
        ],
      }),
      servedMemories,
      servedObservations
    );
    expect(memoryUsage.map((u) => u.memoryId)).toEqual(["mem_served"]);
  });

  it("drops observationUsage with invented ids and re-serves statements from the stored belief", () => {
    const { observationUsage } = draftFromPlan(
      JSON.stringify({
        subject: "s",
        body: "b",
        observationUsage: [
          { observationId: "obs_invented", influence: "i" },
          { observationId: "obs_served", influence: "i" },
        ],
      }),
      servedMemories,
      servedObservations
    );
    expect(observationUsage.map((u) => u.observationId)).toEqual(["obs_served"]);
    // The statement/confidence come from the STORED observation, not the LLM's
    // claim — the model cannot fabricate what a belief says.
    expect(observationUsage[0].statement).toBe(servedObservations[0].statement);
    expect(observationUsage[0].confidence).toBe(servedObservations[0].confidence);
  });
});

describe("Phase 5 — memory ≠ learning: recall alone is not learning", () => {
  beforeEach(freshOrchestrator);

  it("remembering an event creates no learned state; learning through consolidation does", async () => {
    // (A) REMEMBERING: the event exists in episodic memory, but no outcome was
    // ever run through the consolidation loop — nothing was LEARNED.
    const beforeRemember = await handleDraftRequest(req(ACME));
    expect(beforeRemember.learning!.observationsConsidered).toEqual([]);
    expect(beforeRemember.decision!.constraints).toEqual([]);

    const provider = getMemoryProvider();
    await provider.retain([
      {
        content:
          "Follow-up to Jane Doe (CTO) at Acme: sent 'Q3 pricing overview'. Outcome: no_reply. AE feedback: pricing is too aggressive.",
        context: "sales follow-up outcome",
        tags: ["acme"],
        metadata: { accountId: "acme" },
      },
    ]);

    const afterRemember = await handleDraftRequest(req(ACME));
    // It remembers the event (recalls it)…
    expect(afterRemember.recalledMemories.length).toBeGreaterThan(0);
    // …but the learned state is EMPTY: no beliefs, no constraints from evidence.
    expect(afterRemember.learning!.observationsConsidered).toEqual([]);
    expect(afterRemember.decision!.constraints).toEqual([]);

    // (B) LEARNING: the same event flows through OUTCOME → CONSOLIDATION.
    const run1 = await handleDraftRequest(req(ACME));
    await handleOutcomeReport(run1.runId, {
      outcome: "no_reply",
      feedback: "pricing is too aggressive",
    });
    const afterLearning = await handleDraftRequest(req(ACME));

    // Learned state now exists and is consulted…
    expect(afterLearning.learning!.observationsConsidered.length).toBeGreaterThan(0);
    // …and it changes CONCRETE decision fields beyond mere recall:
    expect(afterLearning.decision!.constraints.length).toBeGreaterThan(0);
    expect(afterLearning.decision!.reasoningFactors.some((f) => f.source === "observation")).toBe(
      true
    );
    // If this were a plain RAG chatbot, the learned path would equal the
    // remember-only path. Learning must differ — the test fails otherwise.
    expect(afterLearning.decision).not.toEqual(afterRemember.decision);
    expect(afterLearning.draft.strategyLabels).not.toEqual(afterRemember.draft.strategyLabels);
  });
});
