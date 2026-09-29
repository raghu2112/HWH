#!/usr/bin/env node
/**
 * Replays the EXACT sequence the UI "Run Learning Demo" button executes
 * (same 9 steps, same inputs as DEMO_SCRIPT in copilot-workspace.tsx) and
 * asserts the state transitions a judge must be able to see:
 *   generic → failure → belief → changed strategy → success → contradiction
 *   → uncertainty-aware decision, with recalled-memory counts rising.
 * Usage: node scripts/verify-ui-demo.mjs [baseUrl]
 */
const base = process.argv[2] ?? "http://localhost:3000";

const ACCOUNT = {
  accountId: "vertexone",
  company: "VertexOne Technologies",
  contactName: "Ananya Rao",
  contactRole: "VP Operations",
  situationNotes:
    "Enterprise workflow-automation deal (~$240k ARR) in legal review. Ananya went quiet after we shared the implementation quote.",
};

async function api(path, init) {
  const res = await fetch(base + path, init);
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
const post = (path, body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
let failed = false;
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

await api("/api/demo/reset", { method: "DELETE" });

// Steps 1–9, identical to the UI demo script.
const r1 = await api("/api/agent/draft", post("/api/agent/draft", { account: ACCOUNT, goal: "re-engage after the quote" }));
check(r1.recalledMemories.length === 0, "step 1: generic first decision, zero recalled memories", `strategy="${r1.decision.selectedStrategy}", recalled=${r1.recalledMemories.length}`);

await api("/api/agent/outcome", post("/api/agent/outcome", { runId: r1.runId, outcome: "no_reply", feedback: "the follow-up led with pricing right after the implementation quote landed — re-open with operational value instead" }));

const r2a = await api("/api/agent/draft", post("/api/agent/draft", { account: ACCOUNT, goal: "re-engage with the implementation timeline and pricing" }));
check(r2a.recalledMemories.length > 0, "step 3: Hindsight recall fires on second interaction", `recalled=${r2a.recalledMemories.length}`);

await api("/api/agent/outcome", post("/api/agent/outcome", { runId: r2a.runId, outcome: "no_reply", feedback: "same issue — the ask circled back to pricing and rollout cost before value was established" }));

const r2 = await api("/api/agent/draft", post("/api/agent/draft", { account: ACCOUNT, goal: "re-engage after the quote" }));
check(r2.learning.observationsConsidered.length > 0, "step 5: learned belief consulted", `beliefs=${r2.learning.observationsConsidered.length}`);
check(JSON.stringify(r2.draft.strategyLabels) !== JSON.stringify(r1.draft.strategyLabels), "step 5: strategy CHANGED from run 1", `"${r1.draft.strategyLabels}" → "${r2.draft.strategyLabels}"`);

await api("/api/agent/outcome", post("/api/agent/outcome", { runId: r2.runId, outcome: "replied", feedback: "the operational-value angle finally got a response — she replied within an hour asking for the workflow assessment" }));

const r3 = await api("/api/agent/draft", post("/api/agent/draft", {
  account: { ...ACCOUNT, situationNotes: "Ananya's CFO replied directly asking for the full pricing breakdown and the implementation quote." },
  goal: "send the requested pricing breakdown",
}));
check(r3.decision.uncertainties.length > 0 || r3.decision.reasoningFactors.some((f) => f.direction === "uncertainty"), "step 7: contradiction recognized — uncertainty carried", `uncertainties=${r3.decision.uncertainties.length}`);

await api("/api/agent/outcome", post("/api/agent/outcome", { runId: r3.runId, outcome: "meeting_booked", feedback: "pricing was explicitly requested this time — the walkthrough meeting got booked the same day" }));

const r4 = await api("/api/agent/draft", post("/api/agent/draft", { account: ACCOUNT, goal: "re-engage after the quote" }));
const obs = (await api(`/api/memory/observations?accountId=vertexone`)).observations;
const pricing = obs.find((o) => o.patternKey?.startsWith("pricing"));
check(pricing?.status === "contested" && pricing.contradictingEvidence.length >= 2, "step 8: belief contested with retained contradicting evidence (not erased)", `status=${pricing?.status}, contradicting=${pricing?.contradictingEvidence.length}`);
check(r4.decision.uncertainties.length > 0 || r4.decision.reasoningFactors.some((f) => f.direction === "uncertainty"), "step 9: final decision is uncertainty-aware", `confidence=${r4.decision.confidence}`);

// Second run of the whole sequence: determinism via clean reset.
const r1b = await api("/api/agent/draft", post("/api/agent/draft", { account: ACCOUNT, goal: "re-engage after the quote" }));
check(r1b.recalledMemories.length > 0, "no-reset rerun keeps continuity (state persists as designed)", `recalled=${r1b.recalledMemories.length}`);
await api("/api/demo/reset", { method: "DELETE" });
const r1c = await api("/api/agent/draft", post("/api/agent/draft", { account: ACCOUNT, goal: "re-engage after the quote" }));
check(r1c.recalledMemories.length === 0, "reset returns to a true clean state", `recalled=${r1c.recalledMemories.length}`);

console.log(failed ? "\nUI DEMO SEQUENCE: FAILED" : "\nUI DEMO SEQUENCE: ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
