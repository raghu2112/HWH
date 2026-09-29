#!/usr/bin/env node
/**
 * Live Hindsight Cloud smoke test — OPT-IN, never run by `npm test`.
 *
 * Loads HINDSIGHT_* from .env.local (or the environment), starts the built app
 * on a scratch port with a clean DATA_DIR and a DEDICATED THROWAWAY BANK, then
 * drives the full learning arc against the REAL memory backend:
 *
 *   draft (fresh account → no memory) → outcome (negative) → draft (recall fires)
 *   → inspect (bank contents visible) → observations (belief formed)
 *   → cross-account isolation (account B never sees account A's memory)
 *
 * Secrets policy: the key is read into the server's env only; it is never
 * printed, logged, or echoed. All output is redacted for hsk_/gsk_ patterns.
 * Exit code 0 = live verification succeeded; 1 = a real failure;
 * 2 = HINDSIGHT_API_KEY unavailable (verification pending, not a failure).
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { HindsightClient } from "@vectorize-io/hindsight-client";

const PORT = 3102;
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
const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY || envLocal.HINDSIGHT_API_KEY || "";
const HINDSIGHT_BASE_URL = process.env.HINDSIGHT_BASE_URL || envLocal.HINDSIGHT_BASE_URL || "https://api.hindsight.vectorize.io";
// Dedicated bank so the app's own data and this test never share state.
const BANK = process.env.HINDSIGHT_TEST_BANK_ID || `hwh-smoke-${Date.now()}`;

const redact = (s) => String(s).replace(/hsk_[A-Za-z0-9_]+/g, "[REDACTED]").replace(/gsk_[A-Za-z0-9]+/g, "[REDACTED]");

function report(ok, label, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${redact(detail)}` : ""}`);
  if (!ok) process.exitCode = 1;
}

if (!HINDSIGHT_API_KEY) {
  console.log("HINDSIGHT_API_KEY unavailable — live Hindsight Cloud verification PENDING (not a failure).");
  console.log("Set it in .env.local and re-run: node scripts/hindsight-smoke.mjs");
  process.exit(2);
}

console.log(`Live Hindsight Cloud smoke test — bank: ${BANK} (key loaded, never printed)`);

const dataDir = mkdtempSync(path.join(tmpdir(), "hwh-hindsight-smoke-"));
let server;
const client = new HindsightClient({ baseUrl: HINDSIGHT_BASE_URL, apiKey: HINDSIGHT_API_KEY });

async function deleteBank() {
  try { await client.deleteBank(BANK); } catch { /* best-effort cleanup */ }
}
process.on("exit", () => { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} });
process.on("SIGINT", async () => { await deleteBank(); process.exit(130); });

try {
  await deleteBank(); // leftover from an aborted run

  server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: { ...process.env, HINDSIGHT_API_KEY, HINDSIGHT_BASE_URL, HINDSIGHT_BANK_ID: BANK, DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (c) => process.stderr.write(redact(String(c))));

  // 0. Direct connectivity probe (does not count as verification by itself).
  let version = null;
  for (let i = 0; i < 10; i++) {
    try { version = await client.getVersion(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!version) throw new Error("Hindsight Cloud unreachable (getVersion failed) — check key/URL");
  console.log(`  connected: api_version=${version.api_version}, observations=${version.features?.observations}`);

  // 1. Server up + provider selection.
  let health = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) { health = await res.json(); break; }
    } catch { /* not up yet */ }
  }
  if (!health) throw new Error("server did not start");
  report(health.memoryMode === "hindsight-cloud", "provider selection: key present → hindsight-cloud mode", `memoryMode=${health.memoryMode}, llmMode=${health.llmMode}`);
  report(health.hindsightReachable === true, "health endpoint verifies live connectivity (getVersion)", `version=${health.hindsightVersion}`);

  const ACCOUNT = {
    accountId: "acme-hs-smoke",
    company: "Acme",
    contactName: "Ravi Patel",
    contactRole: "CFO",
    situationNotes: "Renewal decision lands this month; champion asked us to hold off.",
  };

  // 2. RUN 1 — fresh account: draft must show NO recalled memory.
  const res1 = await fetch(`${BASE}/api/agent/draft`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT, goal: "re-engage after hold" }),
  });
  const run1 = await res1.json();
  if (!res1.ok) throw new Error(`draft 1 failed: ${run1.error}`);
  report(run1.memorySource === "hindsight", "retain/recall path targets real Hindsight bank", `memorySource=${run1.memorySource}`);
  report(run1.recalledMemories.length === 0, "fresh account: honest empty recall (no fabricated experience)", `${run1.recalledMemories.length} memories`);
  report(run1.recalledMemories.length === 0 && (run1.learning?.observationsConsidered?.length ?? 0) === 0, "no experience → deciding with zero recalled memories and zero beliefs", `strategy="${run1.decision?.selectedStrategy}", confidence=${run1.decision?.confidence}`);

  // 3. Outcome with AE feedback → retain into the real bank.
  const res1b = await fetch(`${BASE}/api/agent/outcome`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: run1.runId, outcome: "no_reply", feedback: "pricing came up too early for a renewal-stage account" }),
  });
  const run1b = await res1b.json();
  if (!res1b.ok) throw new Error(`outcome 1 failed: ${run1b.error}`);
  report(run1b.retainedMemoryIds.length > 0, "outcome retained into Hindsight Cloud", `${run1b.retainedMemoryIds.length} memories`);

  // 4. RUN 2 — recall must now return the retained experience FROM THE CLOUD.
  // (Extraction is queued server-side; poll rather than sleep.)
  let run2 = null;
  for (let i = 0; i < 12 && !run2; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res2 = await fetch(`${BASE}/api/agent/draft`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: ACCOUNT, goal: "re-engage after hold" }),
    });
    const j = await res2.json();
    if (!res2.ok) throw new Error(`draft 2 failed: ${j.error}`);
    if (j.recalledMemories.length > 0) run2 = j;
  }
  if (!run2) throw new Error("recall never surfaced the retained memory within the poll window");
  report(run2.recalledMemories.some((m) => m.text.includes("Ravi Patel") || m.text.includes("no_reply") || m.text.includes("no reply")), "Hindsight recall returns the retained experience", run2.recalledMemories[0]?.text?.slice(0, 90));
  const memChanged =
    JSON.stringify(run2.decision?.reasoningFactors ?? []) !== JSON.stringify(run1.decision?.reasoningFactors ?? []) ||
    run2.decision?.selectedStrategy !== run1.decision?.selectedStrategy;
  report(memChanged, "MEMORY CHANGES THE DECISION: run-2 factors/strategy differ from run-1", `"${run1.decision?.selectedStrategy}" → "${run2.decision?.selectedStrategy}"`);

  // 5. Learning layer over the real bank: observations + mental model.
  const obsRes = await fetch(`${BASE}/api/memory/observations?accountId=${ACCOUNT.accountId}`);
  const obsJson = await obsRes.json();
  report(obsJson.observations?.length > 0, "consolidated belief formed from cloud-retained evidence", obsJson.observations?.[0]?.statement?.slice(0, 90));
  const mmRes = await fetch(`${BASE}/api/memory/mental-model?accountId=${ACCOUNT.accountId}`);
  const mmJson = await mmRes.json();
  report(mmRes.ok && typeof mmJson.model?.beliefs !== "undefined", "account mental model served", `native=${mmJson.native}`);

  // 6. Cross-account isolation against the REAL backend.
  const resB = await fetch(`${BASE}/api/agent/draft`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: { ...ACCOUNT, accountId: "otherbank-corp", company: "OtherBank Corp", contactName: "Dana Lee", contactRole: "COO" },
      goal: "first touch",
    }),
  });
  const runB = await resB.json();
  if (!resB.ok) throw new Error(`draft B failed: ${runB.error}`);
  report(runB.recalledMemories.length === 0, "account isolation: account B never recalls account A's cloud memory", `${runB.recalledMemories.length} leaked memories`);

  // 7. Bank inspection: raw contents visible (memory made inspectable).
  const inspRes = await fetch(`${BASE}/api/memory/inspect?q=${encodeURIComponent("Acme renewal pricing")}&accountId=${ACCOUNT.accountId}`);
  const inspJson = await inspRes.json();
  report(inspRes.ok && inspJson.count >= 0, "memory inspectable through the same recall path the agent uses", `count=${inspJson.count}`);

  console.log(process.exitCode === 1 ? "\nLIVE HINDSIGHT CLOUD VERIFICATION: FAILED (see FAIL lines)" : "\nLIVE HINDSIGHT CLOUD VERIFICATION: PASSED");
} catch (err) {
  console.error(`FAIL  ${redact(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  await deleteBank(); // scratch bank is throwaway by design
  console.log(`(scratch bank ${BANK} deleted, scratch data dir removed)`);
}
