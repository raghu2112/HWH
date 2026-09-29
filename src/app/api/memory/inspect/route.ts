import { NextResponse } from "next/server";
import { getMemoryProvider } from "@/lib/memory/factory";
import { getEnv } from "@/lib/config/env";
import type { DraftRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/memory/inspect?q=...&accountId=...
 * Shows exactly what the agent "knows" right now for an account — the same
 * recall path the agent itself uses, exposed for audit/demo purposes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const accountId = url.searchParams.get("accountId")?.trim();

  if (!q) {
    return NextResponse.json({ error: "q (query) is required" }, { status: 400 });
  }

  const fakeRequest: DraftRequest = {
    account: {
      accountId: accountId ?? "unassigned",
      company: q,
      contactName: "",
      contactRole: "",
      situationNotes: q,
    },
  };

  try {
    const memories = await getMemoryProvider().recall(fakeRequest);
    return NextResponse.json({
      query: q,
      accountId: accountId ?? null,
      memoryMode: getEnv().hindsightEnabled ? "hindsight-cloud" : "local-file",
      count: memories.length,
      memories,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/memory/inspect] failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
