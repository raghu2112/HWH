import { describe, it, expect, beforeEach } from "vitest";
import { getEnv, resetEnv } from "@/lib/config/env";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalMemoryProvider } from "@/lib/memory/local-provider";
import { MockLLMProvider } from "@/lib/llm/provider";
import { buildDraftPrompt, buildOutcomeMemory } from "@/lib/agent/prompts";
import {
  classifyEvidence,
  confidenceFor,
  consolidate,
  evidenceFromOutcome,
  buildMentalModel,
} from "@/lib/memory/consolidator";
import { RunStore } from "@/lib/store/runs";
import type {
  AccountContext,
  AccountMentalModel,
  DraftRequest,
  MemoryEvidence,
  Observation,
  RecalledMemory,
} from "@/lib/types";

function makeDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hwh-test-"));
}

const GLOBO: AccountContext = {
  accountId: "globomantics",
  company: "Globomantics",
  contactName: "Priya Sharma",
  contactRole: "VP Engineering",
  situationNotes: "Champion went quiet after the pricing call.",
};

function req(account: AccountContext = GLOBO): DraftRequest {
  return { account, goal: "re-engage after silence" };
}

const EMPTY_MENTAL_MODEL: AccountMentalModel = {
  accountId: GLOBO.accountId,
  generatedAt: new Date().toISOString(),
  beliefs: [],
  uncertainties: [],
  approachesToRepeat: [],
  approachesToAvoid: [],
  observationIds: [],
};

function evidence(overrides: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    runId: "run_test",
    summary: "Follow-up 'Q3 pricing overview' → no reply",
    outcome: "no_reply",
    valence: "negative",
    feedback: "pricing is too aggressive for this stage",
    occurredAt: new Date().toISOString(),
    accountId: GLOBO.accountId,
    strategyLabels: ["pricing-led-cta"],
    ...overrides,
  };
}

describe("LocalMemoryProvider (Hindsight contract fallback)", () => {
  let provider: LocalMemoryProvider;
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeDataDir();
    provider = new LocalMemoryProvider({ dataDir });
  });

  it("starts empty and stays generic-safe", async () => {
    const memories = await provider.recall(req());
    expect(memories).toEqual([]);
  });

  it("retains and recalls account-scoped memories", async () => {
    await provider.retain([
      {
        content:
          "Follow-up to Priya Sharma (VP Engineering) at Globomantics: sent 'Q3 pricing overview'. Outcome: no_reply. AE feedback: pricing is too aggressive for this stage.",
        context: "sales follow-up outcome",
        tags: ["outcome", "globomantics"],
        metadata: { accountId: "globomantics" },
      },
    ]);

    const memories = await provider.recall(req());
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0].text).toContain("Globomantics");
  });

  it("does not leak memories across accounts", async () => {
    await provider.retain([
      {
        content: "Globomantics pricing discussion stalled.",
        context: "sales follow-up outcome",
        tags: ["globomantics"],
        metadata: { accountId: "globomantics" },
      },
    ]);

    const other = await provider.recall({
      account: { ...GLOBO, accountId: "initech", company: "Initech" },
    });
    expect(other).toEqual([]);
  });

  it("exposes the learning layer: observations + mental model", async () => {
    const obs: Observation = {
      id: "obs_1",
      accountId: GLOBO.accountId,
      statement:
        "Account globomantics: recurring friction around price/budget sensitivity.",
      confidence: 0.74,
      supportingEvidence: [evidence(), evidence({ runId: "run_test_2" })],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      sourceMemoryIds: ["mem_1"],
      patternKey: "pricing@globomantics",
      tags: ["pricing", GLOBO.accountId],
    };
    await provider.saveObservations([obs]);

    const recalled = await provider.recallObservations(req());
    expect(recalled.length).toBe(1);
    expect(recalled[0].statement).toContain("price/budget");

    const { model, native } = await provider.getAccountMentalModel(GLOBO.accountId);    expect(native).toBe(false);
    expect(model.beliefs.length).toBe(1);
    expect(model.beliefs[0].confidence).toBe(0.74);
    expect(model.approachesToAvoid.length).toBeGreaterThan(0);

    // Strict account isolation on the learning layer too.
    const foreign = await provider.recallObservations({
      account: { ...GLOBO, accountId: "initech", company: "Initech" },
    });
    expect(foreign).toEqual([]);
  });
});

describe("MockLLMProvider — behavior changes with memory", () => {
  const llm = new MockLLMProvider();

  it("produces a generic plan when no memories exist", async () => {
    const prompt = buildDraftPrompt({
      account: GLOBO,
      memories: [],
      observations: [],
      mentalModel: EMPTY_MENTAL_MODEL,
    });
    const raw = await llm.complete([
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ]);
    const plan = JSON.parse(raw);
    expect(plan.memoryUsage).toEqual([]);
    expect(plan.strategyLabels).toContain("generic-first-touch");
  });

  it("avoids repeating failures when no_reply memory is recalled", async () => {
    const memories: RecalledMemory[] = [
      {
        id: "mem_1",
        text:
          "Follow-up to Priya Sharma (VP Engineering) at Globomantics: sent 'Q3 pricing overview'. Outcome: no_reply. AE feedback: pricing is too aggressive for this stage.",
        type: "world",
        tags: ["outcome"],
      },
    ];
    const prompt = buildDraftPrompt({
      account: GLOBO,
      memories,
      observations: [],
      mentalModel: EMPTY_MENTAL_MODEL,
    });
    const raw = await llm.complete([
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ]);
    const plan = JSON.parse(raw);
    expect(plan.strategyLabels).toContain("avoid-repeat-failure");
    expect(plan.memoryUsage.length).toBe(1);
    expect(plan.memoryUsage[0].memoryId).toBe("mem_1");
  });

  it("builds on success when a replied memory is recalled", async () => {
    const memories: RecalledMemory[] = [
      {
        id: "mem_2",
        text: "Follow-up to Priya Sharma (VP Engineering) at Globomantics: sent 'security deep-dive invite'. Outcome: replied.",
        type: "world",
        tags: ["outcome"],
      },
    ];
    const prompt = buildDraftPrompt({
      account: GLOBO,
      memories,
      observations: [],
      mentalModel: EMPTY_MENTAL_MODEL,
    });
    const raw = await llm.complete([
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ]);
    const plan = JSON.parse(raw);
    expect(plan.strategyLabels).toContain("build-on-success");
  });
});

describe("MockLLMProvider — behavior changes with consolidated observations", () => {
  const llm = new MockLLMProvider();

  function obs(overrides: Partial<Observation> = {}): Observation {
    return {
      id: "obs_pricing",
      accountId: GLOBO.accountId,
      statement: "Account globomantics: recurring friction around price/budget sensitivity.",
      confidence: 0.74,
      supportingEvidence: [],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      sourceMemoryIds: [],
      patternKey: "pricing@globomantics",
      tags: ["pricing"],
      ...overrides,
    };
  }

  function run(prompt: { system: string; user: string }) {
    return llm.complete([
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ]).then((raw) => JSON.parse(raw));
  }

  it("defers pricing when an active pricing-friction belief exists", async () => {
    const prompt = buildDraftPrompt({
      account: GLOBO,
      memories: [],
      observations: [obs()],
      mentalModel: EMPTY_MENTAL_MODEL,
    });
    const plan = await run(prompt);
    expect(plan.strategyLabels).toContain("defer-pricing");
    expect(plan.observationUsage.length).toBe(1);
    expect(plan.observationUsage[0].influence).toContain("pricing");
  });

  it("acknowledges a contradicted belief instead of blindly reusing it", async () => {
    const contradicted = obs({
      id: "obs_contradicted",
      status: "contested",
      confidence: 0.35,
      supportingEvidence: [evidence(), evidence({ runId: "run_2" })],
      contradictingEvidence: [
        evidence({ outcome: "replied", valence: "positive", feedback: undefined }),
      ],
    });
    const prompt = buildDraftPrompt({
      account: GLOBO,
      memories: [],
      observations: [contradicted],
      mentalModel: EMPTY_MENTAL_MODEL,
    });
    const plan = await run(prompt);
    expect(plan.strategyLabels).toContain("acknowledge-contradiction");
    expect(plan.observationUsage[0].influence).toContain("contradict");
  });

  it("holds a weak single-example belief loosely without contradicting it", async () => {
    const weak = obs({
      id: "obs_weak",
      status: "contested",
      confidence: 0.4,
      supportingEvidence: [evidence()],
      contradictingEvidence: [],
    });
    const prompt = buildDraftPrompt({
      account: GLOBO,
      memories: [],
      observations: [weak],
      mentalModel: EMPTY_MENTAL_MODEL,
    });
    const plan = await run(prompt);
    expect(plan.strategyLabels).toContain("hold-lightly");
    expect(plan.observationUsage[0].influence).toContain("weak");
  });
});

describe("consolidator — evidence → observations → mental model", () => {
  it("classifies evidence by dimension and valence", () => {
    const priceFriction = evidence();
    expect(classifyEvidence(priceFriction, "pricing")).toBe("support");
    expect(classifyEvidence(priceFriction, "security")).toBeNull();

    const success = evidence({
      outcome: "replied",
      valence: "positive",
      feedback: undefined,
      summary: "Follow-up 'security deep-dive' → replied",
    });
    // Success while pricing was in play contradicts the friction belief.
    expect(classifyEvidence(success, "security")).toBe("against");
  });

  it("keeps a single-example belief low-confidence and unconfirmed (grounding floor)", () => {
    const { observations, delta } = consolidate([evidence()], []);
    expect(observations.length).toBe(1);
    const obs = observations[0];
    expect(obs.status).toBe("contested"); // never ACTIVE from one example
    expect(obs.confidence).toBeLessThan(0.5);
    expect(obs.statement).toContain("possible friction");
    expect(obs.statement).toContain("unconfirmed");
    expect(delta.observationsCreated.length).toBe(1);
  });

  it("never invents a belief from success alone", () => {
    const success = evidence({
      outcome: "replied",
      valence: "positive",
      feedback: undefined,
      summary: "Follow-up 'pricing overview' → replied",
    });
    const { observations, delta } = consolidate([success], []);
    expect(observations).toEqual([]);
    expect(delta.observationsCreated).toEqual([]);
    expect(delta.mentalModelNote).toContain("No pattern crossed");
  });

  it("creates an active belief once evidence crosses MIN_EVIDENCE", () => {
    const { observations, delta } = consolidate(
      [evidence(), evidence({ runId: "run_2" })],
      []
    );
    expect(observations.length).toBe(1);
    const obs = observations[0];
    expect(obs.status).toBe("active");
    expect(obs.patternKey).toBe("pricing@globomantics");
    expect(obs.confidence).toBeGreaterThan(0);
    expect(delta.observationsCreated.length).toBe(1);
    expect(delta.mentalModelNote).toContain("New belief");
  });

  it("strengthens an existing belief and reports the delta", () => {
    const first = consolidate([evidence(), evidence({ runId: "run_2" })], []);
    const existing = first.observations;
    const second = consolidate([evidence({ runId: "run_3" })], existing);

    const updated = second.observations.find((o) => o.patternKey === "pricing@globomantics");
    expect(updated).toBeDefined();
    expect(updated!.supportingEvidence.length).toBe(3);
    expect(second.delta.observationsUpdated.length).toBe(1);
    expect(second.delta.observationsUpdated[0].afterConfidence).toBeGreaterThan(
      second.delta.observationsUpdated[0].beforeConfidence
    );
  });

  it("marks a belief contested when contradicting evidence arrives — without deleting or resetting it", () => {
    const first = consolidate([evidence(), evidence({ runId: "run_2" })], []);
    const success = evidence({
      outcome: "replied",
      valence: "positive",
      feedback: undefined,
      summary: "Follow-up 'pricing overview' → replied",
    });
    const second = consolidate([success], first.observations);
    const obs = second.observations.find((o) => o.patternKey === "pricing@globomantics");
    expect(obs!.status).toBe("contested");
    expect(obs!.contradictingEvidence.length).toBe(1);

    // Contradiction as LEARNING, not erasure: the updated belief keeps its
    // identity, its creation date, and the FULL historical evidence record —
    // every pre-contradiction run id remains inspectable alongside the new one.
    expect(obs!.id).toBe(first.observations[0].id);
    expect(obs!.createdAt).toBe(first.observations[0].createdAt);
    const historicalRunIds = obs!.supportingEvidence.map((e) => e.runId);
    expect(historicalRunIds).toContain("run_test");
    expect(historicalRunIds).toContain("run_2");
    expect(obs!.contradictingEvidence.map((e) => e.runId)).toContain("run_test"); // the contradicting run
    // And the statement now encodes the conflict instead of the old certainty.
    expect(obs!.statement).toContain("mixed evidence");
  });

  it("keeps a belief contested when contradictions merely balance the support", () => {
    const success = evidence({
      outcome: "replied",
      valence: "positive",
      feedback: undefined,
      summary: "Follow-up 'pricing overview' → replied",
    });
    // A previous belief exists with two supporting outcomes; two successes
    // balance the ledger → still contested, not silently reinforced nor dropped.
    const prior: Observation = {
      id: "obs_prior",
      accountId: GLOBO.accountId,
      statement: "Account globomantics: recurring friction around price/budget sensitivity.",
      confidence: 0.74,
      supportingEvidence: [evidence(), evidence({ runId: "run_2" })],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      sourceMemoryIds: [],
      patternKey: "pricing@globomantics",
      tags: ["pricing"],
    };
    const { observations } = consolidate([success, success], [prior]);
    const obs = observations.find((o) => o.patternKey === "pricing@globomantics");
    expect(obs!.status).toBe("contested");
    expect(obs!.contradictingEvidence.length).toBe(2);
  });

  it("retires a belief when contradicting evidence dominates the support", () => {
    const success = evidence({
      outcome: "replied",
      valence: "positive",
      feedback: undefined,
      summary: "Follow-up 'pricing overview' → replied",
    });
    const prior: Observation = {
      id: "obs_prior",
      accountId: GLOBO.accountId,
      statement: "Account globomantics: recurring friction around price/budget sensitivity.",
      confidence: 0.74,
      supportingEvidence: [evidence(), evidence({ runId: "run_2" })],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      sourceMemoryIds: [],
      patternKey: "pricing@globomantics",
      tags: ["pricing"],
    };
    // Three successes strictly outweigh the two prior friction signals.
    const { observations } = consolidate([success, success, success], [prior]);
    const obs = observations.find((o) => o.patternKey === "pricing@globomantics");
    expect(obs!.status).toBe("retired");
  });

  it("caps confidence below 1.0 so beliefs stay revisable", () => {
    const evidenceList = Array.from({ length: 12 }, (_, i) =>
      evidence({ runId: `run_${i}` })
    );
    const { observations } = consolidate(evidenceList, []);
    expect(observations[0].confidence).toBeLessThanOrEqual(0.9);
  });

  it("confidenceFor honors the diminishing-returns curve and penalties", () => {
    expect(confidenceFor(0, 0)).toBe(0);
    const one = confidenceFor(1, 0);
    const two = confidenceFor(2, 0);
    expect(two).toBeGreaterThan(one);
    expect(two - one).toBeLessThan(one); // diminishing
    expect(confidenceFor(3, 1)).toBeLessThan(confidenceFor(3, 0));
  });

  it("builds a mental model with repeat/avoid guidance from evidence", () => {
    const { observations } = consolidate(
      [evidence(), evidence({ runId: "run_2" })],
      []
    );
    const model = buildMentalModel(GLOBO.accountId, observations);
    expect(model.beliefs.length).toBe(1);
    expect(model.approachesToAvoid.join(" ")).toContain("pricing-led-cta");
    expect(model.observationIds).toEqual(observations.map((o) => o.id));
  });
});

describe("evidenceFromOutcome — provenance from a run", () => {
  it("derives evidence strictly from the reported outcome", () => {
    const ev = evidenceFromOutcome({
      runId: "run_x",
      account: GLOBO,
      draftSubject: "Q3 pricing overview",
      strategyLabels: ["pricing-led-cta"],
      outcome: "no_reply",
      feedback: "pricing is too aggressive",
      memoryIds: ["mem_x"],
      occurredAt: new Date().toISOString(),
    });
    expect(ev.runId).toBe("run_x");
    expect(ev.memoryId).toBe("mem_x");
    expect(ev.valence).toBe("negative");
    expect(ev.summary).toContain("Q3 pricing overview");
    expect(ev.summary).toContain("no reply");
  });
});

describe("buildOutcomeMemory — what the agent learns from an outcome", () => {
  it("retains experience and playbook corrections with run provenance", () => {
    const memories = buildOutcomeMemory({
      account: GLOBO,
      draft: { subject: "Q3 pricing overview", body: "…", strategyLabels: [] },
      outcome: "no_reply",
      feedback: "pricing is too aggressive for this stage",
      memoryUsage: [],
      runId: "run_42",
    });
    expect(memories.length).toBe(2);
    expect(memories[0].content).toContain("Outcome: no_reply");
    expect(memories[0].tags).toContain("globomantics");
    expect(memories[0].metadata.runId).toBe("run_42");
    expect(memories[1].content).toContain("pricing is too aggressive");
  });

  it("retains only experience when no feedback is given", () => {
    const memories = buildOutcomeMemory({
      account: GLOBO,
      draft: { subject: "s", body: "b", strategyLabels: [] },
      outcome: "replied",
      memoryUsage: [],
      runId: "run_43",
    });
    expect(memories.length).toBe(1);
  });
});

describe("RunStore — audit trail", () => {
  it("saves, lists, and attaches outcomes", async () => {
    const dataDir = makeDataDir();
    const store = new RunStore({ dataDir });
    const run = {
      runId: "run_1",
      createdAt: new Date().toISOString(),
      request: req(),
      recalledMemories: [],
      memorySource: "local" as const,
      recallQuery: "q",
      memoryUsage: [],
      draft: { subject: "s", body: "b", strategyLabels: [] },
      llmMode: "mock" as const,
      retainedMemoryIds: [],
    };
    await store.save(run);
    expect(await store.get("run_1")).toBeDefined();
    expect((await store.list()).length).toBe(1);

    await store.attachOutcome("run_1", {
      outcome: "no_reply",
      feedback: "too pushy",
      reportedAt: new Date().toISOString(),
    });
    const updated = await store.get("run_1");
    expect(updated?.outcome?.outcome).toBe("no_reply");
    const stats = await store.stats();
    expect(stats.withOutcome).toBe(1);
    expect(stats.byResult.no_reply).toBe(1);
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("env contract", () => {
  it("degrades gracefully with no keys", () => {
    delete process.env.HINDSIGHT_API_KEY;
    delete process.env.GROQ_API_KEY;
    resetEnv();
    const env = getEnv();
    expect(env.hindsightEnabled).toBe(false);
    expect(env.llmEnabled).toBe(false);
  });
});
