import { getEnv } from "../config/env";
import { HindsightProvider } from "./hindsight-provider";
import { LocalMemoryProvider } from "./local-provider";
import type { MemoryProvider } from "./provider";

let cached: MemoryProvider | undefined;

/**
 * Hindsight-first selection: use real Hindsight Cloud when HINDSIGHT_API_KEY is
 * set; otherwise fall back to the local file-backed provider so the app and
 * demo never block on missing credentials.
 */
export function getMemoryProvider(): MemoryProvider {
  if (cached) return cached;
  const env = getEnv();
  if (env.hindsightEnabled) {
    cached = new HindsightProvider();
  } else {
    cached = new LocalMemoryProvider();
  }
  return cached;
}

/** Test hook: reset the cached provider singleton. */
export function resetMemoryProvider(): void {
  cached = undefined;
}
