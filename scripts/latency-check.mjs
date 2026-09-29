#!/usr/bin/env node
/**
 * Measures ACTUAL latency of the canonical demo path (no invented targets).
 * Usage: node scripts/latency-check.mjs [baseUrl]
 * Prints per-call wall time for the draft/outcome sequence + call counts.
 */
const base = process.argv[2] ?? "http://localhost:3000";

const account = {
  accountId: "vertexone-latency",
  company: "VertexOne Technologies",
  contactName: "Ananya Rao",
  contactRole: "VP Operations",
  situationNotes:
    "Enterprise workflow-automation deal (~$240k ARR) in legal review. Ananya went quiet after we shared the implementation quote.",
};

async function timed(label, p, path2, init) {
  const t0 = performance.now();
  const res = await fetch(base + path2, init);
  const json = await res.json();
  if (!res.ok) throw new Error(`${label}: ${json.error}`);
  if (p) await p(json);
  const ms = Math.round(performance.now() - t0);
  console.log(`${String(ms).padStart(6)} ms  ${label}`);
  return { json, ms };
}

const post = (path2, body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Reset is local-fallback-only (409 in cloud mode) — expected, not an error.
await fetch(base + "/api/demo/reset", { method: "DELETE" }).catch(() => undefined);
await timed("health", null, "/api/health");

const steps = [
  ["draft 1 (LLM + recall + mental model)", null, "/api/agent/draft", post("/api/agent/draft", { account, goal: "re-engage after the quote" })],
];
const r1 = await timed(...steps[0]);
await timed("outcome 1 (retain + consolidate)", null, "/api/agent/outcome", post("/api/agent/outcome", { runId: r1.json.runId, outcome: "no_reply", feedback: "pricing pushed too early" }));
const r2a = await timed("draft 2a", null, "/api/agent/draft", post("/api/agent/draft", { account, goal: "re-engage with implementation timeline" }));
await timed("outcome 2a", null, "/api/agent/outcome", post("/api/agent/outcome", { runId: r2a.json.runId, outcome: "no_reply", feedback: "pricing again too early" }));
const r2 = await timed("draft 2b (learning applied)", null, "/api/agent/draft", post("/api/agent/draft", { account, goal: "re-engage after the quote" }));
await timed("outcome 2b (success)", null, "/api/agent/outcome", post("/api/agent/outcome", { runId: r2.json.runId, outcome: "replied", feedback: "value-first worked" }));
const r3 = await timed("draft 3 (contradiction)", null, "/api/agent/draft", post("/api/agent/draft", { account: { ...account, situationNotes: "CFO asked for the full pricing breakdown." }, goal: "send the requested pricing breakdown" }));
await timed("outcome 3 (meeting booked)", null, "/api/agent/outcome", post("/api/agent/outcome", { runId: r3.json.runId, outcome: "meeting_booked", feedback: "pricing explicitly requested" }));
await timed("draft 4 (uncertainty-aware)", null, "/api/agent/draft", post("/api/agent/draft", { account, goal: "re-engage after the quote" }));
await timed("observations read", null, `/api/memory/observations?accountId=${account.accountId}`);
await timed("mental model read", null, `/api/memory/mental-model?accountId=${account.accountId}`);

console.log("\nCall structure per draft: 1 Groq call, 1 episodic recall, 1 observation recall, 1-2 mental-model calls.");
console.log("Call structure per outcome: 1 sync retain, 1 observation retain-back, 1 mental-model refresh (all Hindsight when cloud).");
