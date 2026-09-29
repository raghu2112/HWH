/**
 * Failure-path and edge-case tests — the judge-demo reliability contract:
 * a transient provider failure must never fabricate learning, fabricate
 * provenance, contaminate another account, or silently turn weak evidence
 * into certainty.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { LocalMemoryProvider } from "@/lib/memory/local-provider";
import { MockLLMProvider, GroqLLMProvider as GroqProvider } from "@/lib/llm/provider";
import {
  handleDraftRequest,
  handleOutcomeReport,
  draftFromPlan,
  _setProviderOverridesForTests,
} from "@/lib/agent/orchestrator";
import { getRunStore } from "@/lib/store/runs";
import {
  confidenceFor,
  consolidate,
  evidenceFromOutcome,
  patternKeyFor,
  MIN_EVIDENCE,
} from "@/lib/memory/consolidator";
import { rankObservations } from "@/lib/memory/provider";
import type {
  AccountContext,
  DraftRequest,
  MemorySource,
  Observation,
  RecalledMemory,
  RetainedMemory,
} from "@/lib/types";
import type { MemoryProvider } from "@/lib/memory/provider";
import type { LLMProvider } from "@/lib/llm/provider";

// Scratch data dir for the global run store (set before any getEnv() call).
const dataDir = mkdtempSync(path.join(tmpdir(), "hwh-failure-"));
process.env.DATA_DIR = dataDir;

const VERTEX: AccountContext = {
  accountId: "vertexone",
  company: "VertexOne Technologies",
  contactName: "Ananya Rao",
  contactRole: "VP Operations",
  situationNotes: "Enterprise workflow-automation deal in legal review.",
};

function req(account: AccountContext = VERTEX): DraftRequest {
  return { account, goal: "re-engage after the quote" };
}

/** LLM that always fails — simulates quota/network/500 conditions. */
class FailingLLM implements LLMProvider {
  readonly mode = "live" as const;
  constructor(private readonly err: Error) {}
  async complete(): Promise<string> {
    throw this.err;
  }
}

/**
 * Provider wrapper that fails exactly ONE operation — to prove each failure
 * produces its specified degradation, not a crash and not fake success.
 */
class PartialOutageProvider implements MemoryProvider {
  readonly source: MemorySource = "hindsight";
  constructor(
    private readonly inner: MemoryProvider,
    private readonly fail: "retain" | "saveObservations"
  ) {}
  retain(m: RetainedMemory[]): Promise<string[]> {
    if (this.fail === "retain")
      return Promise.reject(new Error("hindsight write failed (simulated outage)"));
    return this.inner.retain(m);
  }
  recall(r: DraftRequest, l?: number): Promise<RecalledMemory[]> {
    return this.inner.recall(r, l);
  }
  async health(): Promise<{ ok: boolean; source: MemorySource; version?: string }> {
    return { ok: false, source: this.source };
  }
  recallObservations(r: DraftRequest): Promise<Observation[]> {
    return this.inner.recallObservations(r);
  }
  listObservations(a: string): Promise<Observation[]> {
    return this.inner.listObservations(a);
  }
  saveObservations(o: Observation[]): Promise<void> {
    if (this.fail === "saveObservations")
      return Promise.reject(new Error("ledger write failed (simulated outage)"));
    return this.inner.saveObservations(o);
  }
  getAccountMentalModel(a: string) {
    return this.inner.getAccountMentalModel(a);
  }
}

function evidence(overrides: Partial<Parameters<typeof evidenceFromOutcome>[0]> = {}) {
  return evidenceFromOutcome({
    runId: "run_test",
    account: VERTEX,
    draftSubject: "Workflow assessment next steps",
    strategyLabels: ["value-first"],
    outcome: "no_reply",
    feedback: "pricing came up too early",
    memoryIds: ["mem_1"],
    occurredAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("Groq timeout & error handling", () => {
  it("converts a hung provider into a controlled error naming the wait, with no key material", async () => {
    process.env.LLM_TIMEOUT_MS = "80";
    try {
      const p = new GroqProvider({
        apiKey: "gsk_SECRET_key_abc123",
        baseUrl: "http://127.0.0.1:9", // nothing listens here
        model: "openai/gpt-oss-120b",
      });
      await p.complete([{ role: "user", content: "hi" }]);
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("Groq call failed");
      expect(msg).not.toContain("gsk_SECRET_key_abc123");
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
    }
  });

  it("retries a 429 rate limit with backoff and succeeds — no fabricated output on the first attempt", { timeout: 15000 }, async () => {
    let calls = 0;
    const server: Server = createServer((_q, r) => {
      calls++;
      if (calls === 1) {
        r.writeHead(429, { "Content-Type": "application/json", "retry-after": "1" });
        r.end(JSON.stringify({ error: { message: "Rate limit reached (TPM)" } }));
      } else {
        r.writeHead(200, { "Content-Type": "application/json" });
        r.end(JSON.stringify({ choices: [{ message: { content: "{\"subject\":\"s\",\"body\":\"b\"}" } }] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      process.env.LLM_TIMEOUT_MS = "2000";
      const p = new GroqProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}`, model: "m" });
      const out = await p.complete([{ role: "user", content: "hi" }]);
      expect(out).toContain("subject");
      expect(calls).toBe(2); // retried exactly once, then succeeded
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
      server.close();
    }
  });

  it("malformed model output (empty content) is rejected downstream, not stored", async () => {
    // Empty content from a 200 response must surface as an unusable plan.
    const { draftFromPlan } = await import("@/lib/agent/orchestrator");
    expect(() => draftFromPlan("", [], [])).toThrow(/non-JSON plan|missing subject/);
  });

  it("sanitizes upstream error bodies: no key echo, no raw dump", async () => {
    const server: Server = createServer((_q, r) => {
      r.writeHead(500, { "Content-Type": "application/json" });
      r.end(JSON.stringify({ error: "boom", auth: "Bearer gsk_SECRET_key_abc123" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const p = new GroqProvider({
        apiKey: "gsk_SECRET_key_abc123",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      await p.complete([{ role: "user", content: "hi" }]);
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("Groq call failed (500)");
      expect(msg).not.toContain("gsk_SECRET_key_abc123");
    } finally {
      server.close();
    }
  });
});

describe("LLM failure during draft", () => {
  beforeEach(() => {
    _setProviderOverridesForTests({
      memory: new LocalMemoryProvider({ dataDir }),
      llm: new FailingLLM(new Error("quota exceeded (simulated)")),
    });
  });
  afterEach(() => _setProviderOverridesForTests({}));

  it("rejects with a controlled error and stores no run, no memory, no fabricated learning", async () => {
    await expect(handleDraftRequest(req())).rejects.toThrow(/reasoning failed.*quota exceeded/);
    expect(await getRunStore().list()).toHaveLength(0);
    expect(await new LocalMemoryProvider({ dataDir }).recall(req())).toHaveLength(0);
  });
});

describe("memory outage during draft", () => {
  afterEach(() => _setProviderOverridesForTests({}));

  it("degrades to an honest generic decision — zero recalled knowledge, no fabrication, no crash", async () => {
    _setProviderOverridesForTests({
      memory: new PartialOutageProvider(new LocalMemoryProvider({ dataDir }), "retain"),
      llm: new MockLLMProvider(),
    });
    const run = await handleDraftRequest(req());
    expect(run.recalledMemories).toHaveLength(0);
    expect(run.learning?.observationsConsidered ?? []).toHaveLength(0);
    // Every factor traces to the current situation only — nothing invented.
    expect(run.decision?.reasoningFactors.every((f) => f.source === "situation")).toBe(true);
    expect(run.decision?.confidence ?? 1).toBeLessThanOrEqual(0.5);
  });
});

describe("memory outage during outcome reporting", () => {
  afterEach(() => _setProviderOverridesForTests({}));

  it("retain failure → outcome recorded, beliefs still consolidated, learning note states the degraded truth", async () => {
    const inner = new LocalMemoryProvider({ dataDir });
    _setProviderOverridesForTests({
      memory: new PartialOutageProvider(inner, "retain"),
      llm: new MockLLMProvider(),
    });
    const run = await handleDraftRequest(req());
    const done = await handleOutcomeReport(run.runId, {
      outcome: "no_reply",
      feedback: "pricing was pushed too early",
    });
    expect(done.outcome?.outcome).toBe("no_reply");
    expect(done.retainedMemoryIds).toHaveLength(0);
    expect(done.learning?.learningDelta?.mentalModelNote).toContain(
      "Memory write to Hindsight failed"
    );
    // Learning did NOT silently vanish — the belief layer still updated.
    expect((await inner.listObservations(VERTEX.accountId)).length).toBeGreaterThan(0);
  });

  it("consolidation persistence failure → hard error, no fake learning stored", async () => {
    const inner = new LocalMemoryProvider({ dataDir });
    _setProviderOverridesForTests({
      memory: new PartialOutageProvider(inner, "saveObservations"),
      llm: new MockLLMProvider(),
    });
    // A different account isolates this test from beliefs saved by earlier
    // tests in this file (the ledger is shared within the scratch dataDir).
    const otherReq = req({ ...VERTEX, accountId: "isolation-probe", company: "Isolation Probe Inc" });
    const run = await handleDraftRequest(otherReq);
    await expect(
      handleOutcomeReport(run.runId, { outcome: "no_reply", feedback: "pricing too early" })
    ).rejects.toThrow(/consolidation persistence failed/);
    // The belief ledger must remain empty for this account — learning was NOT
    // fabricated despite the outcome being reported.
    expect(await inner.listObservations("isolation-probe")).toHaveLength(0);
  });
});

describe("provenance & evidence edge cases (pure functions)", () => {
  const memories: RecalledMemory[] = [
    { id: "mem_real", text: "pricing friction", tags: ["outcome"] },
  ];
  const observations: Observation[] = [
    {
      id: "obs_real",
      accountId: VERTEX.accountId,
      statement: "possible friction around pricing",
      confidence: 0.4,
      supportingEvidence: [],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "contested",
      sourceMemoryIds: [],
      patternKey: patternKeyFor("pricing", VERTEX.accountId),
      tags: ["pricing", VERTEX.accountId],
    },
  ];

  it("hallucinated memory id in a factor is dropped", () => {
    const { decisionFields } = draftFromPlan(
      JSON.stringify({
        subject: "s",
        body: "b",
        strategyLabels: [],
        reasoningFactors: [
          { source: "memory", refId: "mem_REAL", statement: "invented", direction: "pushed toward" },
          { source: "memory", refId: "mem_real", statement: "real", direction: "pushed toward" },
        ],
      }),
      memories,
      observations
    );
    expect(decisionFields.reasoningFactors).toHaveLength(1);
    expect(decisionFields.reasoningFactors[0].refId).toBe("mem_real");
  });

  it("hallucinated observation id in observationUsage is dropped", () => {
    const { observationUsage } = draftFromPlan(
      JSON.stringify({
        subject: "s",
        body: "b",
        strategyLabels: [],
        observationUsage: [
          { observationId: "obs_invented", influence: "x" },
          { observationId: "obs_real", influence: "y" },
        ],
      }),
      memories,
      observations
    );
    expect(observationUsage).toHaveLength(1);
    expect(observationUsage[0].observationId).toBe("obs_real");
  });

  it("repeated identical negative outcomes strengthen with diminishing returns and stay under the cap", () => {
    const one = confidenceFor(1, 0);
    const three = confidenceFor(3, 0);
    const ten = confidenceFor(10, 0);
    expect(one).toBeGreaterThan(0);
    expect(three).toBeGreaterThan(one);
    expect(ten).toBeLessThanOrEqual(0.9); // revisable, never certain
    expect(three - one).toBeGreaterThan(ten - three); // diminishing
  });

  it("conflicting positive/negative outcomes → contested, not silently reinforced", () => {
    const ev = [
      evidence(), // negative, pricing in play
      // Success WITH pricing explicitly in play (strategy label carries the
      // dimension) and no blaming feedback → contradiction evidence.
      evidence({
        outcome: "meeting_booked",
        feedback: undefined,
        strategyLabels: ["pricing-walkthrough"],
      }),
    ];
    const { observations: obs } = consolidate(ev, []);
    const o = obs.find((x) => x.patternKey === patternKeyFor("pricing", VERTEX.accountId));
    expect(o?.status).toBe("contested");
    expect(o?.supportingEvidence.length).toBe(1);
    expect(o?.contradictingEvidence.length).toBe(1);
  });

  it("a success alone never invents a new friction belief", () => {
    const { observations: obs } = consolidate([
      evidence({ outcome: "meeting_booked", feedback: undefined }),
    ], []);
    expect(obs).toHaveLength(0);
  });

  it("stale evidence loses ranking: equal-strength beliefs rank by recency, both remain consultable", () => {
    const old = {
      ...observations[0],
      id: "obs_old",
      updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
    };
    const fresh = { ...observations[0], id: "obs_fresh", updatedAt: new Date().toISOString() };
    const ranked = rankObservations([old, fresh]);
    expect(ranked[0].id).toBe("obs_fresh");
    expect(ranked).toHaveLength(2); // stale belief still visible, never hidden
  });

  it("a weak single example stays below the active-belief evidence floor", () => {
    const { observations: obs } = consolidate([evidence()], []);
    const o = obs.find((x) => x.patternKey === patternKeyFor("pricing", VERTEX.accountId));
    expect(o?.supportingEvidence.length).toBeLessThan(MIN_EVIDENCE);
    expect(o?.status).not.toBe("active");
    expect(o?.statement).toContain("unconfirmed");
  });
});

describe("recall scoping — irrelevant, cross-account, empty", () => {
  let local: LocalMemoryProvider;

  beforeEach(() => {
    local = new LocalMemoryProvider({ dataDir: mkdtempSync(path.join(tmpdir(), "hwh-scope-")) });
  });

  it("empty memory → honest empty recall on first interaction", async () => {
    expect(await local.recall(req())).toHaveLength(0);
  });

  it("irrelevant same-account memory is stored but never served into the decision", async () => {
    await local.retain([
      {
        content: "Quarterly board deck finalized and circulated to stakeholders.",
        context: "internal planning notes",
        // tags:[] deliberately — the account tag is a scoping key, not a
        // keyword signal, and must not manufacture relevance on its own.
        tags: [],
        metadata: { accountId: "vertexone" },
      },
    ]);
    expect(await local.recall(req())).toHaveLength(0); // zero keyword overlap → below floor
  });

  it("a relevant memory IS served (the floor does not hide real experience)", async () => {
    await local.retain([
      {
        content:
          "Follow-up to Ananya Rao (VP Operations) at VertexOne Technologies: sent 'Pricing overview'. Outcome: no_reply. AE feedback: pricing too early.",
        context: "sales follow-up outcome",
        tags: ["outcome", "vertexone"],
        metadata: { accountId: "vertexone" },
      },
    ]);
    const got = await local.recall(req());
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].text).toContain("VertexOne");
  });

  it("another account's relevant memory never leaks across accounts", async () => {
    await local.retain([
      {
        content:
          "Follow-up to Dana Lee (COO) at OtherVision Corp: sent 'Pricing overview'. Outcome: no_reply.",
        context: "sales follow-up outcome",
        tags: ["outcome", "othervision"],
        metadata: { accountId: "othervision" },
      },
    ]);
    expect(await local.recall(req())).toHaveLength(0);
  });

  it("cross-account evidence never merges into another account's belief", () => {
    const obsA: Observation = {
      id: "obs_a",
      accountId: "vertexone",
      statement: "friction around pricing",
      confidence: 0.74,
      supportingEvidence: [evidence()],
      contradictingEvidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      sourceMemoryIds: [],
      patternKey: patternKeyFor("pricing", "vertexone"),
      tags: ["pricing", "vertexone"],
    };
    // Account B's evidence with the SAME dimension must not touch account A.
    const evB = evidence({ account: { ...VERTEX, accountId: "othervision" } });
    const { observations: out } = consolidate([evB], [obsA]);
    const a = out.find((o) => o.accountId === "vertexone");
    const b = out.find((o) => o.accountId === "othervision");
    expect(a?.supportingEvidence).toHaveLength(1); // unchanged
    expect(a?.status).toBe("active");
    expect(b?.accountId).toBe("othervision"); // B's belief is separate
  });
});
