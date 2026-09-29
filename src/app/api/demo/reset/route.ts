import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getEnv } from "@/lib/config/env";
import { getMemoryProvider } from "@/lib/memory/factory";
import { LocalMemoryProvider } from "@/lib/memory/local-provider";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/demo/reset?accountId=...
 *
 * Demo hygiene ONLY — never a production endpoint. Wipes the local audit trail
 * (runs) and the application-level learning ledger (observations) so a fresh
 * demonstration cannot be contaminated by stale state. Memory backing is
 * provider-dependent: with the local provider the memories file is cleared too;
 * with Hindsight Cloud, account experience lives in the remote bank and is NOT
 * deleted here (use a fresh HINDSIGHT_BANK_ID for a from-zero cloud demo).
 *
 * Scopes to one accountId when given; clears everything when omitted.
 * Refuses to run when Hindsight Cloud is active — cloud state is never
 * deleted through this route.
 */
export async function DELETE(req: Request) {
  const env = getEnv();
  if (env.hindsightEnabled) {
    return NextResponse.json(
      {
        error:
          "reset is only available on the local fallback; use a fresh HINDSIGHT_BANK_ID for a from-zero Hindsight Cloud demo",
      },
      { status: 409 }
    );
  }

  const accountId = new URL(req.url).searchParams.get("accountId")?.trim() || null;
  const dataDir = env.dataDir;

  const cleared: string[] = [];
  try {
    // 1. Audit trail (runs + outcomes). Whole-file clear is correct even when
    // scoped: a partial-history demo would misrepresent the learning arc.
    await fs.rm(path.join(dataDir, "runs.json"), { force: true });
    cleared.push("runs");
  } catch (err) {
    console.error("[api/demo/reset] runs clear failed:", err);
  }

  try {
    // 2. Learning ledger — observations for the scope only (they are
    // account-partitioned, so per-account removal is exact).
    const obsFile = path.join(dataDir, "observations.json");
    let observations: Array<{ accountId: string }> = [];
    try {
      observations = JSON.parse(await fs.readFile(obsFile, "utf8"));
    } catch {
      observations = [];
    }
    if (accountId) {
      const kept = observations.filter((o) => o.accountId !== accountId);
      await fs.writeFile(obsFile, JSON.stringify(kept, null, 2), "utf8");
      cleared.push(`observations:${accountId}`);
    } else {
      await fs.rm(obsFile, { force: true });
      cleared.push("observations");
    }
  } catch (err) {
    console.error("[api/demo/reset] observations clear failed:", err);
  }

  try {
    // 3. Local episodic memories — same scoping rule as the provider's own
    // isolation: tag or metadata accountId membership.
    const memFile = path.join(dataDir, "memories.json");
    let memories: Array<{ tags?: string[]; metadata?: Record<string, string> }> = [];
    try {
      memories = JSON.parse(await fs.readFile(memFile, "utf8"));
    } catch {
      memories = [];
    }
    if (accountId) {
      const kept = memories.filter(
        (m) => !(m.tags ?? []).includes(accountId) && m.metadata?.accountId !== accountId
      );
      await fs.writeFile(memFile, JSON.stringify(kept, null, 2), "utf8");
      cleared.push(`memories:${accountId}`);
    } else {
      await fs.rm(memFile, { force: true });
      cleared.push("memories");
    }
  } catch (err) {
    console.error("[api/demo/reset] memories clear failed:", err);
  }

  // The provider may hold an in-memory cache over the same files; dropping it
  // is required or recall keeps serving deleted memories and the next persist
  // would resurrect them on disk.
  const provider = getMemoryProvider();
  if (provider instanceof LocalMemoryProvider) provider.clearInMemoryCache();

  return NextResponse.json({ ok: true, scope: accountId ?? "all", cleared });
}
