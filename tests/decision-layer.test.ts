import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnv, getEnv } from "@/lib/config/env";
import { resetMemoryProvider, getMemoryProvider } from "@/lib/memory/factory";
import { resetLLMProvider, getLLMProvider } from "@/lib/llm/factory";
import { RunStore, resetRunStore } from "@/lib/store/runs";
import { resetObservationStore } from "@/lib/store/observations";
import { handleDraftRequest, handleOutcomeReport } from "@/lib/agent/orchestrator";
import type { AccountContext, DraftRequest } from "@/lib/types";

/**
 * Decision-layer tests: verify the BUSINESS behavior of the agent — that
 * decisions are complete, memory-influenced, contradiction-aware, isolated
 * per account, and deterministic. These run the real orchestrator with the
 * real local provider + mock LLM in an isolated data dir.
 */

function makeDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hwh-decision-"));
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

describe("AgentDecision — decision object integrity", () => {
  beforeEach(freshOrchestrator);

  it("baseline decision carries no memory influence and a generic strategy", async () => {
    const run = await handleDraftRequest(req());
    const d = run.decision!;
    expect(d).toBeDefined();
    expect(d.situation).toContain("Acme");
    expect(d.objective).toBe("re-engage after silence");
    expect(d.selectedStrategy).toContain("Generic first-touch");
    expect(d.confidence).toBe(0.4); // no learned basis
    expect(d.reasoningFactors.some((f) => f.source === "situation")).toBe(true);
    expect(d.reasoningFactors.every((f) => f.source !== "memory" && f.source !== "observation")).toBe(true);
    expect(d.action.subject).toBe(run.draft.subject);
    expect(d.expectedOutcome).toContain("no learned basis");
  });

  it("is deterministic: identical requests produce identical decisions", async () => {
    const a = await handleDraftRequest(req());
    const b = await handleDraftRequest(req());
    expect(b.decision).toEqual(a.decision);
    expect(b.draft).toEqual(a.draft);
  });

  it("decision provenance only references knowledge actually provided", async () => {
    const run = await handleDraftRequest(req());
    const d = run.decision!;
    const memoryIds = new Set(run.recalledMemories.map((m) => m.id));
    const beliefIds = new Set(run.learning?.observationsConsidered.map((o) => o.observationId) ?? []);
    for (const f of d.reasoningFactors) {
      if (f.source === "memory") expect(memoryIds.has(f.refId!)).toBe(true);
      if (f.source === "observation") expect(beliefIds.has(f.refId!)).toBe(true);
      if (f.source === "situation") expect(f.refId).toBeUndefined();
    }
  });
});

describe("AgentDecision — experience changes decisions (the core loop)", () => {
  beforeEach(freshOrchestrator);

  it("RUN1 negative outcome → RUN2 same situation uses a different strategy", async () => {
    const run1 = await handleDraftRequest(req());
    expect(run1.decision!.selectedStrategy).toContain("Generic first-touch");

    await handleOutcomeReport(run1.runId, {
      outcome: "no_reply",
      feedback: "pricing is too aggressive for this stage",
    });

    const run2 = await handleDraftRequest(req());
    const d2 = run2.decision!;
    // The decision must now consume experience:
    expect(run2.recalledMemories.length).toBeGreaterThan(0);
    expect(d2.selectedStrategy).not.toContain("Generic first-touch");
    expect(d2.reasoningFactors.some((f) => f.source === "memory")).toBe(true);
    // The UI/audit claim is backed by structured data:
    expect(d2.reasoningFactors.length).toBeGreaterThan(run1.decision!.reasoningFactors.length);
    expect(d2.confidence).toBeGreaterThan(run1.decision!.confidence);
  });

  it("repeated evidence hardens a weak belief and changes the confidence the decision reports", async () => {
    const run1 = await handleDraftRequest(req());
    await handleOutcomeReport(run1.runId, {
      outcome: "no_reply",
      feedback: "pricing is too aggressive for this stage",
    });
    const mid = await handleDraftRequest(req());
    expect(mid.learning!.observationsConsidered[0].confidence).toBeLessThan(0.5);

    // Second failed cycle with the AE naming the same friction (as in practice).
    const run1b = await handleDraftRequest(req(ACME, "follow up with a pricing-led ask"));
    await handleOutcomeReport(run1b.runId, {
      outcome: "no_reply",
      feedback: "another pricing-led ask; still too aggressive",
    });

    const run3 = await handleDraftRequest(req());
    const belief = run3.learning!.observationsConsidered.find((o) =>
      o.statement.includes("price")
    );
    expect(belief).toBeDefined();
    expect(belief!.confidence).toBeGreaterThanOrEqual(0.7); // crossed the floor
    expect(run3.decision!.constraints.length).toBeGreaterThan(0); // belief → constraint
  });

  it("contradiction: success evidence contests the belief and the next decision carries uncertainty", async () => {
    // Build an active pricing-friction belief (two independent failed cycles).
    const run1 = await handleDraftRequest(req());
    await handleOutcomeReport(run1.runId, { outcome: "no_reply", feedback: "pricing is too aggressive" });
    const run1b = await handleDraftRequest(req());
    await handleOutcomeReport(run1b.runId, {
      outcome: "no_reply",
      feedback: "still too aggressive on pricing",
    });

    // Contradict it: a pricing-led exchange books a meeting.
    const run2 = await handleDraftRequest(req(ACME, "send the requested pricing sheet"));
    await handleOutcomeReport(run2.runId, {
      outcome: "meeting_booked",
      feedback: "they engaged immediately once pricing was on the table",
    });

    const provider = getMemoryProvider();
    const pricing = (await provider.listObservations("acme")).find((o) =>
      o.patternKey.startsWith("pricing")
    );
    expect(pricing!.status).toBe("contested"); // NOT erased, NOT blindly kept active
    expect(pricing!.contradictingEvidence.length).toBe(1);

    // The next decision must represent the conflict, not the old certainty.
    const run3 = await handleDraftRequest(req());
    const d3 = run3.decision!;
    expect(d3.uncertainties.length).toBeGreaterThan(0);
    expect(d3.reasoningFactors.some((f) => f.direction === "uncertainty")).toBe(true);
    expect(d3.confidence).toBeLessThan(0.65); // reduced confidence under conflict
    const strategy = `${d3.selectedStrategy} ${run3.draft.strategyLabels.join(" ")}`.toLowerCase();
    expect(
      strategy.includes("verif") || strategy.includes("conflict") || strategy.includes("probe")
    ).toBe(true);
  });

  it("learning delta records the before/after of the mental model", async () => {
    const run1 = await handleDraftRequest(req());
    const withOutcome = await handleOutcomeReport(run1.runId, {
      outcome: "no_reply",
      feedback: "pricing is too aggressive",
    });
    const delta = withOutcome.learning!.learningDelta!;
    expect(delta.observationsCreated.length).toBe(1);
    expect(delta.observationsCreated[0].confidence).toBeLessThan(0.5);
    expect(delta.mentalModelNote).toContain("New belief");
    expect(withOutcome.beforeAfter!.before[0]).toContain("no consolidated beliefs");
    expect(withOutcome.beforeAfter!.after.join(" ")).toContain("price");
  });
});

describe("AgentDecision — account isolation of decisions", () => {
  beforeEach(freshOrchestrator);

  it("decisions for account B are never influenced by account A's experience", async () => {
    // Teach account A that pricing is a hot button.
    const a1 = await handleDraftRequest(req());
    await handleOutcomeReport(a1.runId, { outcome: "no_reply", feedback: "pricing is too aggressive" });
    const a2 = await handleDraftRequest(req());
    await handleOutcomeReport(a2.runId, { outcome: "no_reply" });

    // Account B: same goal, clean slate.
    const B: AccountContext = { ...ACME, accountId: "initech", company: "Initech" };
    const b1 = await handleDraftRequest(req(B));
    expect(b1.recalledMemories).toEqual([]);
    expect(b1.learning!.observationsConsidered).toEqual([]);
    expect(b1.decision!.selectedStrategy).toContain("Generic first-touch");
    expect(b1.decision!.confidence).toBe(0.4);

    // The audit trail keeps the accounts' histories separate.
    const store = new RunStore({ dataDir });
    const aRuns = await store.list("acme");
    const bRuns = await store.list("initech");
    expect(aRuns.length).toBe(2);
    expect(bRuns.length).toBe(1);
  });
});

describe("provider selection — Hindsight-first, local fallback", () => {
  beforeEach(() => {
    resetEnv();
    resetMemoryProvider();
    resetLLMProvider();
  });

  it("selects the local provider and mock LLM when keys are absent", () => {
    delete process.env.HINDSIGHT_API_KEY;
    delete process.env.GROQ_API_KEY;
    resetEnv();
    expect(getEnv().hindsightEnabled).toBe(false);
    expect(getMemoryProvider().source).toBe("local");
    expect(getLLMProvider().mode).toBe("mock");
  });

  it("selects the Hindsight provider and live LLM when keys are present", () => {
    process.env.HINDSIGHT_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";
    resetEnv();
    expect(getEnv().hindsightEnabled).toBe(true);
    expect(getMemoryProvider().source).toBe("hindsight");
    expect(getLLMProvider().mode).toBe("live");
    delete process.env.HINDSIGHT_API_KEY;
    delete process.env.GROQ_API_KEY;
    resetEnv();
    resetMemoryProvider();
    resetLLMProvider();
  });
});
