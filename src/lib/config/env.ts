/**
 * Central environment contract. Read once, imported everywhere.
 * Nothing here throws when optional vars are missing — the app degrades to
 * mock LLM + local memory provider instead of crashing (demo-safety rule).
 */

function str(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() !== "") return raw.trim();
  return fallback;
}

export interface AppEnv {
  /** Hindsight memory configuration */
  hindsightBaseUrl: string;
  hindsightApiKey?: string;
  hindsightBankId: string;
  /** True when BOTH base URL and API key are present → real Hindsight Cloud */
  hindsightEnabled: boolean;

  /** LLM configuration */
  llmApiKey?: string;
  llmBaseUrl: string;
  llmModel: string;
  /** True when an LLM key is present → real LLM; false → deterministic mock */
  llmEnabled: boolean;

  /** File-backed persistence directory */
  dataDir: string;
}

let cached: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (cached) return cached;

  const hindsightBaseUrl = str(
    "HINDSIGHT_BASE_URL",
    "https://api.hindsight.vectorize.io"
  )!;
  const hindsightApiKey = str("HINDSIGHT_API_KEY");
  const hindsightBankId = str("HINDSIGHT_BANK_ID", "acme-sales-copilot")!;

  // Live LLM = Groq's OpenAI-compatible endpoint. The field names stay
  // provider-neutral (llmApiKey/llmBaseUrl/llmModel); only the env vars feed them.
  const llmApiKey = str("GROQ_API_KEY");
  const llmBaseUrl = str("GROQ_BASE_URL", "https://api.groq.com/openai/v1")!;
  const llmModel = str("GROQ_MODEL", "openai/gpt-oss-120b")!;

  cached = {
    hindsightBaseUrl,
    hindsightApiKey,
    hindsightBankId,
    hindsightEnabled: Boolean(hindsightApiKey),

    llmApiKey,
    llmBaseUrl,
    llmModel,
    llmEnabled: Boolean(llmApiKey),

    dataDir: str("DATA_DIR", "./.data")!,
  };
  return cached;
}

/** Test hook: force re-reading environment on next getEnv() call. */
export function resetEnv(): void {
  cached = undefined;
}

/** Human-readable provider status, used by /api/health and the UI banner. */
export function describeEnv(env: AppEnv = getEnv()): {
  memoryMode: "hindsight-cloud" | "local-file";
  llmMode: "live" | "mock";
  warnings: string[];
} {
  const warnings: string[] = [];
  const memoryMode = env.hindsightEnabled ? "hindsight-cloud" : "local-file";
  const llmMode = env.llmEnabled ? "live" : "mock";

  if (!env.hindsightEnabled) {
    warnings.push(
      "HINDSIGHT_API_KEY not set — using local file-backed memory. Set it in .env.local for real Hindsight Cloud."
    );
  }
  if (!env.llmEnabled) {
    warnings.push(
      "GROQ_API_KEY not set — using deterministic mock LLM. Set it in .env.local for live reasoning."
    );
  }
  return { memoryMode, llmMode, warnings };
}
