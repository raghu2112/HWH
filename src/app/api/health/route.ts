import { NextResponse } from "next/server";
import { describeEnv, getEnv } from "@/lib/config/env";
import { getMemoryProvider } from "@/lib/memory/factory";
import { getRunStore } from "@/lib/store/runs";
import type { HealthStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Provider status rules (no overclaiming):
 * - `hindsightConfigured`: credentials exist in env — NOT proof of connectivity.
 * - `hindsightReachable`: connectivity VERIFIED this request via getVersion().
 * - `memoryMode`: which provider is actually serving traffic.
 * - `localFallback`: running without real Hindsight.
 */
export async function GET() {
  const env = getEnv();
  const described = describeEnv(env);
  const memory = getMemoryProvider();

  let hindsightReachable = false;
  let hindsightVersion: string | undefined;
  try {
    const h = await memory.health();
    hindsightReachable = h.ok;
    hindsightVersion = h.version;
  } catch {
    hindsightReachable = false;
  }

  const warnings = [...described.warnings];
  if (env.hindsightEnabled && !hindsightReachable) {
    warnings.push(
      "HINDSIGHT_API_KEY is set but the memory backend could not be reached — check the key/URL. The app is still serving drafts."
    );
  }

  const stats = await getRunStore().stats();
  const status: HealthStatus & { stats: typeof stats } = {
    ok: true,
    memoryMode: described.memoryMode,
    llmMode: described.llmMode,
    hindsightReachable,
    hindsightVersion,
    hindsightConfigured: env.hindsightEnabled,
    localFallback: !env.hindsightEnabled,
    warnings,
    stats,
  };
  return NextResponse.json(status);
}
