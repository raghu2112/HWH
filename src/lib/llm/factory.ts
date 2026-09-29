import { getEnv } from "../config/env";
import { GroqLLMProvider, MockLLMProvider, type LLMProvider } from "./provider";

let cached: LLMProvider | undefined;

/**
 * Groq-first live selection: use Groq's OpenAI-compatible API when GROQ_API_KEY
 * is set; otherwise fall back to the deterministic mock so tests and demos
 * never require a key or a network.
 */
export function getLLMProvider(): LLMProvider {
  if (cached) return cached;
  const env = getEnv();
  cached = env.llmEnabled ? new GroqLLMProvider() : new MockLLMProvider();
  return cached;
}

export function resetLLMProvider(): void {
  cached = undefined;
}
