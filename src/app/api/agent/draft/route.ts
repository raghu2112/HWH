import { NextResponse } from "next/server";
import { handleDraftRequest } from "@/lib/agent/orchestrator";
import type { DraftRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Minimal manual validation — keeps the dependency list lean. */
function validate(body: unknown): { ok: true; value: DraftRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const account = b.account as Record<string, unknown> | undefined;
  if (!account) return { ok: false, error: "account is required" };
  for (const field of ["accountId", "company", "contactName", "contactRole"]) {
    if (typeof account[field] !== "string" || (account[field] as string).trim() === "") {
      return { ok: false, error: `account.${field} must be a non-empty string` };
    }
  }
  return {
    ok: true,
    value: {
      account: {
        accountId: account.accountId as string,
        company: account.company as string,
        contactName: account.contactName as string,
        contactRole: account.contactRole as string,
        situationNotes: typeof account.situationNotes === "string" ? account.situationNotes : "",
      },
      goal: typeof b.goal === "string" ? b.goal : undefined,
    },
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = validate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const run = await handleDraftRequest(parsed.value);
    return NextResponse.json(run, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/draft] failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
