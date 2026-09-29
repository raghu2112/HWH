import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnv } from "@/lib/config/env";
import { resetMemoryProvider, getMemoryProvider } from "@/lib/memory/factory";
import { resetLLMProvider, getLLMProvider } from "@/lib/llm/factory";
import { resetRunStore, getRunStore } from "@/lib/store/runs";
import { resetObservationStore } from "@/lib/store/observations";
import { handleDraftRequest, handleOutcomeReport } from "@/lib/agent/orchestrator";
import type { AccountContext } from "@/lib/types";

/**
 * Task 9 — learning-loop compatibility through the GROQ provider.
 *
 * A localhost stub speaks Groq's OpenAI-compatible /chat/completions wire
 * format, so the REAL GroqLLMProvider (request shaping, auth header, response
 * extraction) runs against the REAL orchestrator: recall → prompt → reasoning →
 * structured decision → provenance validation → action → outcome →
 * consolidation → belief → next decision.
 *
 * This proves wire/pipeline compatibility without any external network call and
 * without claiming live Groq Cloud verification.
 */

const ACME: AccountContext = {
  accountId: "acme",
  company: "Acme",
  contactName: "Jane Doe",
  contactRole: "CTO",
  situationNotes: "Trial expiring; champion quiet.",
};

interface RecordedRequest {
  url: string;
  auth: string | null;
  body: { model?: string; response_format?: unknown; messages?: Array<{ role: string; content: string }> };
}

let server: Server;
let baseUrl = "";
let lastRequest: RecordedRequest | null = null;
/** When true the stub answers with a plan full of invented references. */
let respondWithHallucinatedRefs = false;
/** When true the stub answers with non-JSON garbage. */
let respondWithGarbage = false;

afterEach(() => {
  // Flag hygiene: a failing assertion mid-test must not leak scenario flags
  // into subsequent tests (each test asserts its own stub behavior).
  respondWithHallucinatedRefs = false;
  respondWithGarbage = false;
});

/** Extract observation ids actually served in the prompt (honest-model behavior). */
function servedObservationIds(userPrompt: string): string[] {
  const section = userPrompt.split("CONSOLIDATED OBSERVATIONS")[1]?.split("ACCOUNT MENTAL MODEL")[0] ?? "";
  return [...section.matchAll(/\(id=(obs_[A-Za-z0-9-]+),/g)].map((m) => m[1]);
}

function planJson(userPrompt: string): string {
  if (respondWithGarbage) return "this is not json";
  const obsIds = servedObservationIds(userPrompt);
  if (respondWithHallucinatedRefs) {
    return JSON.stringify({
      subject: "s",
      body: "b",
      strategyLabels: ["x"],
      selectedStrategy: "Invented provenance attempt",
      confidence: 1.5, // out of range — must be rejected by validation
      expectedOutcome: "e",
      reasoningFactors: [
        { source: "memory", refId: "mem_hallucinated", statement: "used a memory never served", direction: "pushed toward" },
        { source: "observation", refId: "obs_hallucinated", statement: "used a belief never served", direction: "pushed toward" },
        { source: "situation", statement: "Current AE input: Trial expiring; champion quiet.", direction: "pushed toward" },
      ],
      memoryUsage: [{ memoryId: "mem_hallucinated", relevance: "r", effect: "e" }],
      observationUsage: [{ observationId: "obs_hallucinated", influence: "i" }],
    });
  }
  // Compliant model: only references ids that were actually in its context.
  const firstObs = obsIds[0];
  return JSON.stringify({
    subject: "Reconnecting with your team",
    body: "Hi Jane, following up on our conversation.",
    strategyLabels: firstObs ? ["observation-informed"] : ["generic-first-touch"],
    selectedStrategy: firstObs ? "Experience-informed follow-up (consulted the account belief)" : "Generic first-touch check-in (no relevant experience yet)",
    confidence: 0.55,
    expectedOutcome: firstObs ? "Reply likelihood informed by prior evidence." : "Modest chance of a reply.",
    reasoningFactors: [
      ...(firstObs
        ? [{ source: "observation", refId: firstObs, statement: "consulted the account belief", direction: "pushed toward" as const }]
        : []),
      { source: "situation", statement: "Current AE input: Trial expiring; champion quiet.", direction: "pushed toward" as const },
    ],
    memoryUsage: [],
    observationUsage: firstObs ? [{ observationId: firstObs, influence: "consulted the account belief" }] : [],
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as RecordedRequest["body"];
      lastRequest = {
        url: req.url ?? "",
        auth: req.headers.authorization ?? null,
        body,
      };
      const userPrompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: planJson(userPrompt) } }],
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Env: Groq selected (key present) but pointed at the LOCAL stub; memory stays local.
  delete process.env.HINDSIGHT_API_KEY;
  process.env.GROQ_API_KEY = "test-key"; // fake, stub-verified only — never printed
  process.env.GROQ_BASE_URL = baseUrl;
  delete process.env.GROQ_MODEL;
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "hwh-groq-"));
  resetEnv();
  resetMemoryProvider();
  resetLLMProvider();
  resetRunStore();
  resetObservationStore();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_BASE_URL;
  resetEnv();
  resetMemoryProvider();
  resetLLMProvider();
  resetRunStore();
  resetObservationStore();
});

describe("Learning loop through GroqLLMProvider (Groq wire format, local stub)", () => {
  it("runs recall → prompt → Groq-shaped reasoning → validated decision, on the provider abstraction", async () => {
    const run = await handleDraftRequest({ account: ACME, goal: "re-engage after silence" });

    // The orchestrator talked to the LLMProvider abstraction and got the LIVE provider.
    expect(run.llmMode).toBe("live");
    expect(getLLMProvider().mode).toBe("live");
    expect(getMemoryProvider().source).toBe("local");

    // Wire format actually sent to the (stub) Groq endpoint: auth + model + structured output.
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.auth).toBe("Bearer test-key"); // key goes ONLY to the endpoint
    expect(lastRequest!.url).toBe("/chat/completions");
    expect(lastRequest!.body.model).toBe("openai/gpt-oss-120b"); // default model
    expect(lastRequest!.body.response_format).toEqual({ type: "json_object" });

    // Prompt structure preserved through the Groq provider.
    const prompt = lastRequest!.body.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(prompt).toContain("RELEVANT EPISODIC MEMORIES");
    expect(prompt).toContain("CONSOLIDATED OBSERVATIONS");
    expect(prompt).toContain("ACCOUNT MENTAL MODEL");

    // The decision object passed the existing validation pipeline.
    expect(run.decision!.selectedStrategy).toContain("Generic first-touch");
    // Range-valid model confidence is honored (validation contract: 0..1).
    expect(run.decision!.confidence).toBe(0.55);
    expect(run.decision!.reasoningFactors.every((f) => f.source === "situation")).toBe(true);
  });

  it("rejects hallucinated references: provenance enforcement stays authoritative over the live model", async () => {
    respondWithHallucinatedRefs = true;
    const run = await handleDraftRequest({ account: ACME, goal: "re-engage after silence" });
    const d = run.decision!;

    // Every invented reference was dropped before storage…
    expect(d.reasoningFactors.some((f) => f.refId === "mem_hallucinated")).toBe(false);
    expect(d.reasoningFactors.some((f) => f.refId === "obs_hallucinated")).toBe(false);
    expect(run.memoryUsage.some((u) => u.memoryId === "mem_hallucinated")).toBe(false);
    expect(
      (run.learning?.observationsConsidered ?? []).some((u) => u.observationId === "obs_hallucinated")
    ).toBe(false);
    // …while honestly-sourced factors survive.
    expect(d.reasoningFactors.some((f) => f.source === "situation")).toBe(true);
    // No usage entries with invented ids survive either (asserted above).
    // Out-of-range model confidence is REJECTED; the decision falls back to
    // confidence derived from actual state (0.4 — nothing served, no memories).
    expect(d.confidence).toBeLessThan(0.6);
    respondWithHallucinatedRefs = false;
  });

  it("rejects malformed model output safely: controlled error, nothing fabricated into storage", async () => {
    respondWithGarbage = true;
    const runsBefore = (await getRunStore().list()).length;
    await expect(
      handleDraftRequest({ account: ACME, goal: "re-engage after silence" })
    ).rejects.toThrow(/LLM returned non-JSON plan/);
    expect((await getRunStore().list()).length).toBe(runsBefore); // nothing persisted
    respondWithGarbage = false;
  });

  it("outcome → consolidation → next decision consults the belief through the Groq provider", async () => {
    const run1 = await handleDraftRequest({ account: ACME, goal: "re-engage after silence" });
    expect(run1.llmMode).toBe("live");

    const withOutcome = await handleOutcomeReport(run1.runId, {
      outcome: "no_reply",
      feedback: "pricing was introduced too early",
    });
    // Consolidation is LLM-independent and unchanged:
    expect(withOutcome.learning!.learningDelta!.observationsCreated.map((o) => o.patternKey)).toContain(
      "pricing@acme"
    );
    expect(withOutcome.retainedMemoryIds.length).toBeGreaterThan(0);

    // Next decision: the compliant-model stub echoes back ONLY ids actually
    // served — proving the belief is supplied to Groq and valid provenance flows.
    const run2 = await handleDraftRequest({ account: ACME, goal: "re-engage after silence" });
    const considered = run2.learning!.observationsConsidered;
    expect(considered.length).toBeGreaterThan(0);
    const d2 = run2.decision!;
    expect(d2.reasoningFactors.some((f) => f.source === "observation")).toBe(true);
    const obsId = considered[0].observationId;
    expect(d2.reasoningFactors.some((f) => f.refId === obsId)).toBe(true);
    expect(d2.beliefsConsulted).toContain(obsId);
    // The served prompt did contain that belief (the model did not invent it).
    const prompt2 = lastRequest!.body.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(prompt2).toContain(obsId);
  });
});
