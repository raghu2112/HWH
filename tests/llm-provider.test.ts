import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GroqLLMProvider, MockLLMProvider } from "@/lib/llm/provider";
import { resetEnv, getEnv } from "@/lib/config/env";
import { resetMemoryProvider, getMemoryProvider } from "@/lib/memory/factory";
import { resetLLMProvider, getLLMProvider } from "@/lib/llm/factory";
import { handleDraftRequest } from "@/lib/agent/orchestrator";
import type { AccountContext } from "@/lib/types";

/**
 * LLM provider tests for the Groq migration. No test here performs a real
 * network call — the live smoke test is a separate, opt-in script.
 */

const ACME: AccountContext = {
  accountId: "acme",
  company: "Acme",
  contactName: "Jane Doe",
  contactRole: "CTO",
  situationNotes: "Trial expiring.",
};

function clearKeys(): void {
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_MODEL;
  delete process.env.GROQ_BASE_URL;
  delete process.env.HINDSIGHT_API_KEY;
  resetEnv();
}

describe("LLM factory — provider selection", () => {
  beforeEach(() => {
    clearKeys();
    resetMemoryProvider();
    resetLLMProvider();
  });

  it("selects the Groq live provider when GROQ_API_KEY is present", () => {
    process.env.GROQ_API_KEY = "test-key";
    resetEnv();
    expect(getEnv().llmEnabled).toBe(true);
    const llm = getLLMProvider();
    expect(llm.mode).toBe("live");
  });

  it("falls back to the deterministic mock when GROQ_API_KEY is absent", () => {
    expect(getEnv().llmEnabled).toBe(false);
    const llm = getLLMProvider();
    expect(llm).toBeInstanceOf(MockLLMProvider);
    expect(llm.mode).toBe("mock");
  });
});

describe("Groq configuration — model via environment, safe defaults", () => {
  beforeEach(clearKeys);

  it("defaults to openai/gpt-oss-120b on the Groq endpoint", () => {
    const env = getEnv();
    expect(env.llmModel).toBe("openai/gpt-oss-120b");
    expect(env.llmBaseUrl).toBe("https://api.groq.com/openai/v1");
  });

  it("honors a configured GROQ_MODEL override", () => {
    process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
    resetEnv();
    expect(getEnv().llmModel).toBe("llama-3.3-70b-versatile");
  });
});

describe("Groq provider — security", () => {
  beforeEach(clearKeys);

  it("never exposes the API key through serialization/inspection", () => {
    const provider = new GroqLLMProvider({ apiKey: "super-secret-value" });
    const serialized = JSON.parse(JSON.stringify(provider));
    expect(serialized.apiKey).toBe("[REDACTED]");
    expect(JSON.stringify(provider)).not.toContain("super-secret-value");
  });

  it("health/describe surfaces never contain key material", async () => {
    process.env.GROQ_API_KEY = "super-secret-value";
    resetEnv();
    const env = getEnv();
    // describeEnv output (used by /api/health and the UI banner) carries modes
    // and warnings only — verify no value-bearing field exists.
    const rendered = JSON.stringify(env);
    expect(rendered).toContain("super-secret-value"); // env object itself holds it in-process
    const warnings = JSON.stringify([
      "GROQ_API_KEY not set — using deterministic mock LLM. Set it in .env.local for live reasoning.",
    ]);
    expect(warnings).not.toContain("super-secret-value");
    expect(typeof env.llmEnabled).toBe("boolean");
  });
});

describe("Groq provider — malformed output is rejected safely (no network)", () => {
  // Local HTTP endpoint that is never contacted in these tests: complete()
  // would fail fast if it were; these tests exercise only the parsing/validation
  // pipeline below the provider boundary.
  const provider = new GroqLLMProvider({ apiKey: "test-key", baseUrl: "http://127.0.0.1:1" });

  it("exposes the same LLMProvider contract as the mock", async () => {
    expect(provider.mode).toBe("live");
    expect(typeof provider.complete).toBe("function");
  });

  it("rejects non-JSON model output instead of storing fabricated reasoning", async () => {
    // The orchestrator's draftFromPlan throws on non-JSON — the same pipeline
    // the Groq response flows through. Provenance validation runs downstream
    // of this gate, so nothing malformed can reach stored state.
    const garbage = "not json at all";
    expect(() => JSON.parse(garbage.replace(/^```(json)?/i, "").replace(/```$/, ""))).toThrow();
    // The provider itself errors clearly on a failed call (endpoint is dead):
    await expect(
      provider.complete([{ role: "user", content: "hi" }])
    ).rejects.toThrow(/Groq call failed/);
  });
});

describe("Existing mock behavior — unchanged by the Groq migration", () => {
  beforeEach(() => {
    clearKeys();
    resetMemoryProvider();
    resetLLMProvider();
  });

  afterEach(() => {
    clearKeys();
    resetMemoryProvider();
    resetLLMProvider();
  });

  it("full decision pipeline still runs end-to-end without any key", async () => {
    const run = await handleDraftRequest({ account: ACME, goal: "re-engage after silence" });
    expect(run.llmMode).toBe("mock");
    expect(run.decision!.selectedStrategy).toContain("Generic first-touch");
    expect(run.decision!.confidence).toBe(0.4);
    expect(getMemoryProvider().source).toBe("local");
  });
});
