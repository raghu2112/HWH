import { NextResponse } from "next/server";
import { getMemoryProvider } from "@/lib/memory/factory";

export const dynamic = "force-dynamic";

/**
 * GET /api/memory/mental-model?accountId=...
 * Answers "what should the agent already know before acting for this account?"
 * `native: true` means a Hindsight bank mental model backs it.
 */
export async function GET(req: Request) {
  const accountId = new URL(req.url).searchParams.get("accountId")?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  try {
    const { model, native } = await getMemoryProvider().getAccountMentalModel(accountId);
    return NextResponse.json({ accountId, native, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/memory/mental-model] failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
