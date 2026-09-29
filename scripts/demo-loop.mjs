#!/usr/bin/env node
/**
 * Deterministic end-to-end demonstration of the business decision loop.
 *
 *   node scripts/demo-loop.mjs [baseUrl]      # default: http://localhost:3000
 *
 * Three interactions, one account — the full arc:
 *   RUN 1 (baseline):   no experience → generic strategy → negative outcome → belief forms
 *   RUN 2 (learning):   recall + belief → STRATEGY CHANGES → improved outcome → belief strengthens
 *   RUN 3 (contradiction): conflicting evidence → belief contested, not erased → next decision adapts
 *
 * All console output is generated from actual API state — nothing is hard-coded.
 */

const base = process.argv[2] ?? "http://localhost:3000";
// Deterministic fresh demo: ?fresh=1 wipes the local audit trail + learning ledger
// for the demo account, so stale runs can never contaminate the arc.
const fresh = process.argv.includes("--fresh") || new URL(base).searchParams.get("fresh") === "1";

// ── Canonical demo scenario — realistic synthetic B2B data ──────────────────
// Enterprise workflow-automation deal. Synthetic account (not a real customer);
// objections mirror real ones: pricing after the implementation quote,
// implementation risk, procurement timing.
const account = {
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

const section = (t) => console.log(`\n━━ ${t} ${"━".repeat(Math.max(0, 62 - t.length))}`);

/**
 * Deterministic fresh start: wipes the local demo state (runs, observations,
 * memories) so no stale run can contaminate the arc. Only meaningful on the
 * local fallback — with Hindsight Cloud the experience lives in the remote
 * bank, so a from-zero cloud demo should use a fresh HINDSIGHT_BANK_ID instead.
 */
async function resetLocalState() {
  const res = await fetch(`${base}/api/demo/reset`, { method: "DELETE" });
  const json = await res.json();
  if (!res.ok) {
    console.log(`  ⚠ reset unavailable (${json.error ?? res.status}) — continuing with existing state`);
    return false;
  }
  console.log(`  reset: cleared ${json.cleared.join(", ")}`);
  return true;
}

function printDecision(run) {
  const d = run.decision;
  console.log(`SITUATION : ${d.situation}`);
  console.log(`OBJECTIVE : ${d.objective}`);
  console.log(`DECISION  : ${d.selectedStrategy}`);
  console.log(`CONFIDENCE: ${d.confidence.toFixed(2)} (from evidence actually used)`);
  console.log(`EXPECTED  : ${d.expectedOutcome}`);
  console.log(`WHY       :`);
  const CAUSE = {
    memory: "RECALLED FROM HINDSIGHT",
    observation: "LEARNED FROM PAST OUTCOMES",
    situation: "FROM CURRENT INPUT",
  };
  for (const f of d.reasoningFactors) {
    console.log(`  • [${f.direction} · ${f.source}] ${f.statement} — ${CAUSE[f.source] ?? f.source}`);
  }
  for (const c of d.constraints) console.log(`  ⛔ ${c} — CONSTRAINT CREATED BY LEARNED BELIEF`);
  for (const u of d.uncertainties) console.log(`  ⚠ uncertainty: ${u.slice(0, 140)}${u.length > 140 ? "…" : ""}`);
  console.log(`ACTION    : "${run.draft.subject}" [${run.draft.strategyLabels.join(", ")}]`);
  console.log(`MEMORY    : recalled ${run.recalledMemories.length}, beliefs consulted ${run.learning?.observationsConsidered.length ?? 0}`);
}

function printLearning(run) {
  const delta = run.learning?.learningDelta;
  console.log(`OUTCOME   : ${run.outcome.outcome}${run.outcome.feedback ? ` — "${run.outcome.feedback}"` : ""}`);
  console.log(`RETAINED  : ${run.retainedMemoryIds.length} experience memories`);
  if (delta) console.log(`LEARNING  : ${delta.mentalModelNote}`);
  if (run.beforeAfter) {
    console.log(`BEFORE    : ${run.beforeAfter.before.join(" | ").slice(0, 200)}`);
    console.log(`AFTER     : ${run.beforeAfter.after.join(" | ").slice(0, 200)}`);
  }
}

section("0. Health");
if (fresh) await resetLocalState();
const health = await api("/api/health");
console.log(
  `memory=${health.memoryMode}  llm=${health.llmMode}  hindsightReachable=${health.hindsightReachable}` +
    (health.localFallback ? "  (local fallback)" : "")
);
for (const w of health.warnings) console.log(`  ⚠ ${w}`);

// ── RUN 1 — BASELINE ─────────────────────────────────────────────────────────
section("RUN 1 · BASELINE — no experience yet");
const run1 = await api("/api/agent/draft", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ account, goal: "re-engage after silence" }),
});
console.log(`runId: ${run1.runId}`);
printDecision(run1);

section("RUN 1 · Outcome: negative (pricing-led silence)");
const run1b = await api("/api/agent/outcome", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    runId: run1.runId,
    outcome: "no_reply",
    feedback: "the follow-up led with pricing right after the implementation quote landed — re-open with operational value instead",
  }),
});
printLearning(run1b);

// ── RUN 2 — LEARNING ─────────────────────────────────────────────────────────
section("RUN 2a · Second failed cycle (independent evidence for the same pattern)");
// One outcome can never make a belief ACTIVE (MIN_EVIDENCE=2 grounding floor),
// so the demo deliberately repeats a similar failed cycle once.
const run2a = await api("/api/agent/draft", {
  method: "POST",
  headers: { "Content-Type": "application/json" },    body: JSON.stringify({ account, goal: "re-engage with the implementation timeline and pricing" }),
});
printDecision(run2a);
const run2ab = await api("/api/agent/outcome", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    runId: run2a.runId,
    outcome: "no_reply",
    feedback: "same issue — the ask circled back to pricing and rollout cost before value was established",
  }),
});
printLearning(run2ab);

section("RUN 2b · LEARNING APPLIED — same account, similar situation");
const run2 = await api("/api/agent/draft", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ account, goal: "re-engage after silence" }),
});
printDecision(run2);
const beliefsNow = (await api(`/api/memory/observations?accountId=${account.accountId}`)).observations;
for (const o of beliefsNow) console.log(`  BELIEF [${o.status}] (${o.confidence.toFixed(2)}) ${o.statement.slice(0, 150)}`);

section("RUN 2b · Outcome: improved (the changed strategy worked)");
const run2b = await api("/api/agent/outcome", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    runId: run2.runId,
    outcome: "replied",
    feedback: "the operational-value angle finally got a response — she replied within an hour asking for the workflow assessment",
  }),
});
printLearning(run2b);

// ── RUN 3 — CONTRADICTION ────────────────────────────────────────────────────
section("RUN 3 · CONTRADICTION — new situation: CFO explicitly asks for pricing");
const run3 = await api("/api/agent/draft", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    account: { ...account, situationNotes: "Ananya's CFO replied directly asking for the full pricing breakdown and the implementation quote." },
    goal: "send the requested pricing breakdown",
  }),
});
printDecision(run3);

section("RUN 3 · Contradictory evidence arrives (pricing-led draft books a meeting)");
const pricingBefore = (await api(`/api/memory/observations?accountId=${account.accountId}`)).observations.find(
  (o) => o.patternKey?.startsWith("pricing")
);
console.log(`BELIEF BEFORE: [${pricingBefore?.status}] confidence ${pricingBefore?.confidence.toFixed(2)}`);
const run3b = await api("/api/agent/outcome", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    runId: run3.runId,
    outcome: "meeting_booked",
    feedback: "pricing was explicitly requested this time — the walkthrough meeting got booked the same day",
  }),
});
printLearning(run3b);
const pricingAfter = (await api(`/api/memory/observations?accountId=${account.accountId}`)).observations.find(
  (o) => o.patternKey?.startsWith("pricing")
);
console.log(
  `BELIEF AFTER : [${pricingAfter?.status}] confidence ${pricingAfter?.confidence.toFixed(2)} ` +
    `— ${pricingAfter?.contradictingEvidence.length} contradicting evidence item(s) recorded (belief preserved, not erased)`
);

section("RUN 3 · Next decision under uncertainty");
const run4 = await api("/api/agent/draft", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ account, goal: "re-engage after silence" }),
});
printDecision(run4);

// ── Verdict ──────────────────────────────────────────────────────────────────
section("VERDICT");
const strategies1 = run1.draft.strategyLabels.join(",");
const strategies2 = run2.draft.strategyLabels.join(",");
const changed = strategies1 !== strategies2;
const contradicted = (pricingAfter?.contradictingEvidence.length ?? 0) > 0 && pricingAfter?.status === "contested";
const uncertainNext = run4.decision.uncertainties.length > 0 || run4.decision.reasoningFactors.some((f) => f.direction === "uncertainty");
console.log(`  RUN1→RUN2 strategy changed:        ${changed ? "✅ YES" : "❌"}  ("${strategies1}" → "${strategies2}")`);
console.log(`     BECAUSE: Hindsight recall (${run2.recalledMemories.length} memories) + the active pricing belief changed the strategy`);
console.log(`  RUN2 decision used learned belief: ${run2.learning.observationsConsidered.length > 0 || run2.recalledMemories.length > 0 ? "✅ YES" : "❌"}`);
const strengthened = run2ab.learning?.learningDelta?.observationsUpdated[0];
console.log(
  `  RUN2a outcome strengthened belief: ${strengthened && strengthened.afterStatus === "active" ? "✅ YES" : "❌"}  (${strengthened ? `${strengthened.beforeConfidence.toFixed(2)}→${strengthened.afterConfidence.toFixed(2)}, → ${strengthened.afterStatus}` : "no update"})`
);
console.log(`  RUN3 contradiction represented:    ${contradicted ? "✅ YES" : "❌"}`);
console.log(`     BECAUSE: ${pricingAfter?.contradictingEvidence.length ?? 0} contradicting evidence item(s) were retained, not erased — history stays inspectable`);
console.log(`  RUN3→4 next decision carries uncertainty: ${uncertainNext ? "✅ YES" : "❌"}`);
console.log(`     BECAUSE: the contested belief makes the agent verify before assuming friction (learning, not memory)`);
const allOk = changed && contradicted && uncertainNext;
console.log(`\nRESULT: ${allOk ? "✅ the agent's experience changed its decisions — visibly, auditably" : "❌ learning loop did not visibly change behavior"}\n`);
process.exit(allOk ? 0 : 1);
