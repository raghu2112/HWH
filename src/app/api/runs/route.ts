import { NextResponse } from "next/server";
import { getRunStore } from "@/lib/store/runs";

export const dynamic = "force-dynamic";

/**
 * GET /api/runs?accountId=...
 * Audit trail of runs. Each run embeds its full causal chain:
 * decision (situation/objective/factors/strategy/confidence/expected),
 * recalled memories + usage, outcome, retained memories, learning delta,
 * and the mental-model before/after. Strictly account-scoped when accountId
 * is provided; omitted means "all accounts" (local single-operator app).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId") ?? undefined;
  const runs = await getRunStore().list(accountId);
  const decisions = await Promise.all(
    runs.map(async (r) => ({
      runId: r.runId,
      createdAt: r.createdAt,
      accountId: r.request.account.accountId,
      company: r.request.account.company,
      situation: r.decision?.situation ?? r.request.account.situationNotes,
      objective: r.decision?.objective ?? r.request.goal ?? "follow up appropriately",
      selectedStrategy: r.decision?.selectedStrategy ?? (r.draft.strategyLabels.join(", ") || null),
      reasoningFactors: r.decision?.reasoningFactors ?? [],
      confidence: r.decision?.confidence ?? null,
      expectedOutcome: r.decision?.expectedOutcome ?? null,
      outcome: r.outcome ?? null,
      learningDelta: r.learning?.learningDelta ?? null,
      beforeAfter: r.beforeAfter ?? null,
    }))
  );
  return NextResponse.json({ count: runs.length, runs, decisions });
}
