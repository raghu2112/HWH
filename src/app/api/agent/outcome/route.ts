import { NextResponse } from "next/server";
import { handleOutcomeReport } from "@/lib/agent/orchestrator";
import type { OutcomeResult } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID: OutcomeResult[] = ["replied", "no_reply", "bounced", "meeting_booked"];

export async function POST(req: Request) {
  let body: { runId?: string; outcome?: string; feedback?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { runId, outcome, feedback } = body;
  if (typeof runId !== "string" || runId === "") {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  if (typeof outcome !== "string" || !VALID.includes(outcome as OutcomeResult)) {
    return NextResponse.json(
      { error: `outcome must be one of: ${VALID.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const run = await handleOutcomeReport(runId, {
      outcome: outcome as OutcomeResult,
      feedback: typeof feedback === "string" && feedback.trim() ? feedback : undefined,
    });
    return NextResponse.json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("not found") ? 404 : 500;
    console.error("[api/outcome] failed:", err);
    return NextResponse.json({ error: message }, { status });
  }
}
