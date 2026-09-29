#!/usr/bin/env node
/**
 * Live Groq smoke test — OPT-IN, never run by `npm test`.
 *
 * Loads GROQ_API_KEY from .env.local (or the environment), starts the built app
 * on a scratch port with a clean DATA_DIR, and drives one complete
 * draft → outcome → next-decision flow through the REAL provider.
 *
 * Secrets policy: the key is read into the server's env only; it is never
 * printed, logged, or echoed here. The prompt/response bodies are summarized,
 * never dumped. Exit code 0 = live verification succeeded; 1 = a real failure;
 * 2 = GROQ_API_KEY unavailable (verification pending, not a failure).
 */
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;

function loadEnvLocal() {
  try {
    const raw = readFileSync(".env.local", "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[2].trim() !== "") out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

const envLocal = loadEnvLocal();
const GROQ_API_KEY = process.env.GROQ_API_KEY || envLocal.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || envLocal.GROQ_MODEL || "openai/gpt-oss-120b";

function report(ok, label, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

if (!GROQ_API_KEY) {
  console.log("GROQ_API_KEY unavailable — live Groq verification PENDING (not a failure).");
  console.log("Set it in .env.local and re-run: node scripts/groq-smoke.mjs");
  process.exit(2);
}

console.log(`Live Groq smoke test — model: ${GROQ_MODEL} (key loaded, never printed)`);

const dataDir = mkdtempSync(path.join(tmpdir(), "hwh-groq-smoke-"));
let server;
try {
  server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: { ...process.env, GROQ_API_KEY, GROQ_MODEL, DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (c) => process.stderr.write(String(c).replace(/gsk_[A-Za-z0-9]+/g, "[REDACTED]")));

  // 1. Server up + provider selection: GROQ_API_KEY present → live mode.
  let health = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) { health = await res.json(); break; }
    } catch { /* not up yet */ }
  }
  if (!health) throw new Error("server did not start");
  report(health.llmMode === "live", "provider selection: GROQ_API_KEY present → live LLM mode", `llmMode=${health.llmMode}, memoryMode=${health.memoryMode}`);

  // 2. Real draft decision through Groq (proves auth + model + parsing/validation).
  const draftRes = await fetch(`${BASE}/api/agent/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: {
        accountId: "acme-smoke",
        company: "Acme",
        contactName: "Jane Doe",
        contactRole: "CTO",
        situationNotes: "Trial expiring; champion quiet since the security questionnaire.",
      },
      goal: "re-engage after silence",
    }),
  });
  const run1 = await draftRes.json();
  if (!draftRes.ok) throw new Error(`draft failed: ${run1.error ?? draftRes.status}`);
  const d1 = run1.decision ?? {};
  report(run1.llmMode === "live", "real Groq completion returned", `model ${GROQ_MODEL} responded via ${BASE}`);
  const decisionFieldsComplete =
    typeof d1.situation === "string" && d1.situation.length > 0 &&
    typeof d1.objective === "string" &&
    Array.isArray(d1.constraints) && Array.isArray(d1.beliefsConsulted) &&
    Array.isArray(d1.uncertainties) && Array.isArray(d1.reasoningFactors) &&
    typeof d1.selectedStrategy === "string" &&
    !!d1.action?.subject && !!d1.action?.body &&
    typeof d1.confidence === "number" && d1.confidence >= 0 && d1.confidence <= 1 &&
    typeof d1.expectedOutcome === "string";
  report(decisionFieldsComplete, "decision passed the existing parsing/validation pipeline", `strategy="${d1.selectedStrategy}", confidence=${d1.confidence}`);
  report(
    (d1.reasoningFactors ?? []).every(
      (f) => f.source !== "memory" || run1.recalledMemories?.some((m) => m.id === f.refId)
    ),
    "provenance valid: no memory referenced that was not served",
    `${d1.reasoningFactors?.length ?? 0} factors`
  );

  // 3. Outcome → consolidation (LLM-independent, must still work).
  const outcomeRes = await fetch(`${BASE}/api/agent/outcome`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: run1.runId,
      outcome: "no_reply",
      feedback: "pricing was introduced too early",
    }),
  });
  const run1o = await outcomeRes.json();
  if (!outcomeRes.ok) throw new Error(`outcome failed: ${run1o.error ?? outcomeRes.status}`);
  const delta = run1o.learning?.learningDelta;
  report(!!delta && (delta.observationsCreated?.length ?? 0) > 0, "outcome → consolidation produced a belief", delta?.mentalModelNote ?? "");

  // 4. Next decision consults the learned belief (learning loop intact on Groq).
  const draft2Res = await fetch(`${BASE}/api/agent/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: {
        accountId: "acme-smoke",
        company: "Acme",
        contactName: "Jane Doe",
        contactRole: "CTO",
        situationNotes: "Trial expiring; champion quiet since the security questionnaire.",
      },
      goal: "re-engage after silence",
    }),
  });
  const run2 = await draft2Res.json();
  if (!draft2Res.ok) throw new Error(`second draft failed: ${run2.error ?? draft2Res.status}`);
  const considered = run2.learning?.observationsConsidered ?? [];
  report(considered.length > 0, "next decision consulted the consolidated belief", `${considered.length} belief(s), first @ confidence ${considered[0]?.confidence?.toFixed?.(2) ?? "?"}`);
  const behaviorChanged =
    JSON.stringify(run2.draft.strategyLabels) !== JSON.stringify(run1.draft.strategyLabels) ||
    run2.decision?.selectedStrategy !== run1.decision?.selectedStrategy;
  report(behaviorChanged, "behavior changed after learning", `"${run1.decision?.selectedStrategy}" → "${run2.decision?.selectedStrategy}"`);

  console.log(`\nRESULT: ${process.exitCode ? "❌ live Groq verification FAILED" : "✅ LIVE GROQ VERIFIED — real request succeeded; full draft→outcome→next-decision loop ran on Groq"}`);
} catch (err) {
  console.error(`\nRESULT: ❌ live Groq smoke test failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  server?.kill();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* scratch dir */ }
}
