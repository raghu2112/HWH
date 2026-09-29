import { NextResponse } from "next/server";
import { getMemoryProvider } from "@/lib/memory/factory";
import { getEnv } from "@/lib/config/env";

export const dynamic = "force-dynamic";

/**
 * GET /api/memory/observations?accountId=...
 * The agent's consolidated beliefs for an account, with supporting and
 * contradicting evidence. Strictly account-scoped.
 */
export async function GET(req: Request) {
  const accountId = new URL(req.url).searchParams.get("accountId")?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  try {
    const provider = getMemoryProvider();
    const observations = await provider.listObservations(accountId);
    return NextResponse.json({
      accountId,
      memoryMode: getEnv().hindsightEnabled ? "hindsight-cloud" : "local-file",
      count: observations.length,
      observations,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/memory/observations] failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
