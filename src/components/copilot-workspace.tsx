"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AccountMentalModel,
  DraftRun,
  HealthStatus,
  Observation,
} from "@/lib/types";

type HealthWithStats = HealthStatus & {
  stats: { runs: number; withOutcome: number; byResult: Record<string, number> };
};

/**
 * Canonical demo scenario — realistic SYNTHETIC B2B data (not a real customer).
 * One account, one situation: an enterprise workflow-automation deal where the
 * contact went quiet after the implementation quote landed. The scripted arc is
 * identical to scripts/demo-loop.mjs and runs the REAL pipeline end to end —
 * the demo only chooses the inputs, never the outputs.
 */
const DEMO_ACCOUNT = {
  accountId: "vertexone",
  company: "VertexOne Technologies",
  contactName: "Ananya Rao",
  contactRole: "VP Operations",
  situationNotes:
    "Enterprise workflow-automation deal (~$240k ARR) in legal review. Ananya went quiet after we shared the implementation quote.",
};

/** The demo script: each step is a real API call with deterministic inputs. */
const DEMO_SCRIPT: Array<{
  label: string;
  kind: "draft" | "outcome";
  body?: Record<string, unknown>;
}> = [
  { label: "Interaction 1 — first decision", kind: "draft" },
  {
    label: "Outcome — no reply",
    kind: "outcome",
    body: {
      outcome: "no_reply",
      feedback:
        "the follow-up led with pricing right after the implementation quote landed — re-open with operational value instead",
    },
  },
  {
    label: "Interaction 2 — second failed cycle",
    kind: "draft",
    body: { goal: "re-engage with the implementation timeline and pricing" },
  },
  {
    label: "Outcome — no reply again",
    kind: "outcome",
    body: {
      outcome: "no_reply",
      feedback:
        "same issue — the ask circled back to pricing and rollout cost before value was established",
    },
  },
  { label: "Interaction 3 — learning applied", kind: "draft" },
  {
    label: "Outcome — replied",
    kind: "outcome",
    body: {
      outcome: "replied",
      feedback:
        "the operational-value angle finally got a response — she replied within an hour asking for the workflow assessment",
    },
  },
  {
    label: "Interaction 4 — contradiction",
    kind: "draft",
    body: {
      account: {
        ...DEMO_ACCOUNT,
        situationNotes:
          "Ananya's CFO replied directly asking for the full pricing breakdown and the implementation quote.",
      },
      goal: "send the requested pricing breakdown",
    },
  },
  {
    label: "Outcome — meeting booked",
    kind: "outcome",
    body: {
      outcome: "meeting_booked",
      feedback:
        "pricing was explicitly requested this time — the walkthrough meeting got booked the same day",
    },
  },
  { label: "Interaction 5 — context-aware decision", kind: "draft" },
];

/** Learning-curve phases shown after each scripted outcome. */
const CURVE = [
  { label: "Interaction 1 — generic", note: "No prior experience to draw on." },
  { label: "Interaction 2 — personalized", note: "Pricing friction remembered from outcome evidence." },
  { label: "Interaction 3 — context-aware", note: "Conflicting pricing evidence recognized, not overwritten." },
] as const;

/** Direction → visual tone for reasoning-factor chips. */
const DIRECTION_TONE: Record<string, string> = {
  "pushed toward": "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "pushed against": "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  uncertainty: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

export default function CopilotWorkspace() {
  const [health, setHealth] = useState<HealthWithStats | null>(null);
  const [account, setAccount] = useState(DEMO_ACCOUNT);
  const [goal, setGoal] = useState("re-engage after the quote");
  const [run, setRun] = useState<DraftRun | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"draft" | "outcome" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspectQuery, setInspectQuery] = useState("VertexOne Ananya pricing workflow");
  const [inspected, setInspected] = useState<
    { memories: Array<{ id: string; text: string; tags?: string[] }> } | null
  >(null);
  const [observations, setObservations] = useState<Observation[] | null>(null);
  const [mentalModel, setMentalModel] = useState<AccountMentalModel | null>(null);
  // Cross-run history: the learning arc (decide → outcome → learned → next decision).
  type HistoryRow = {
    runId: string;
    createdAt: string;
    selectedStrategy: string | null;
    confidence: number | null;
    outcome: string | null;
    feedback: string | null;
    learningNote: string | null;
    // Real derived metrics for the learning curve (from stored run data).
    recalledCount: number;
    beliefsConsulted: number;
  };
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  // One-click demo state: progress through the scripted arc + derived metrics.
  const [demoStep, setDemoStep] = useState(-1); // -1 = not started
  const [demoBusy, setDemoBusy] = useState(false);
  const [curve, setCurve] = useState<{ label: string; note: string }[]>([]);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch {
      /* health is non-critical for the demo flow */
    }
  }, []);

  // Initial load: subscribe to the health endpoint; setState runs in the fetch
  // response callback (the pattern react-hooks/set-state-in-effect requires).
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((res) => res.json())
      .then((json: HealthWithStats) => {
        if (!controller.signal.aborted) setHealth(json);
      })
      .catch(() => {
        /* health is non-critical for the demo flow */
      });
    return () => controller.abort();
  }, []);

  async function draft() {
    setBusy("draft");
    setError(null);
    try {
      const res = await fetch("/api/agent/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: { ...account, situationNotes: account.situationNotes },
          goal,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRun(json as DraftRun);
      loadHealth();
      loadLearning(account.accountId);
      loadHistory(account.accountId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function reportOutcome(outcome: string) {
    if (!run) return;
    setBusy("outcome");
    setError(null);
    try {
      const res = await fetch("/api/agent/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.runId, outcome, feedback: feedback || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRun(json as DraftRun);
      loadHealth();
      loadLearning(account.accountId); // beliefs just changed — refresh panel
      loadHistory(account.accountId); // and the cross-run learning arc
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function inspect() {
    setError(null);
    try {
      const res = await fetch(
        `/api/memory/inspect?q=${encodeURIComponent(inspectQuery)}&accountId=${encodeURIComponent(account.accountId)}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setInspected(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Demo hygiene: wipe local runs/memories/beliefs for a from-zero judge run.
  // Cloud-backed state is never deleted here (the endpoint refuses in that mode).
  const [resetting, setResetting] = useState(false);
  async function resetDemo() {
    if (!window.confirm("Clear all demo state — runs, memories, learned beliefs?")) return;
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/reset", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRun(null);
      setHistory([]);
      setInspected(null);
      setObservations([]);
      setMentalModel(null);
      setDemoStep(-1);
      setCurve([]);
      loadHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  /**
   * One-click judge demo: resets state, then executes the scripted arc through
   * the REAL endpoints (draft → outcome → draft …). No output is fabricated —
   * every decision, learning delta, and contradiction comes from the actual
   * memory → recall → reasoning → consolidation pipeline.
   */
  async function runLearningDemo() {
    if (demoBusy) return;
    setDemoBusy(true);
    setError(null);
    setCurve([]);
    setDemoStep(0);
    try {
      // Fresh arc: clear local state without a confirm — that IS the demo.
      await fetch("/api/demo/reset", { method: "DELETE" });
      setRun(null);
      setHistory([]);
      setInspected(null);
      setObservations([]);
      setMentalModel(null);
      loadHealth();

      // Track the current run in a local variable: React state (`run`) is
      // captured at closure creation and would be STALE across loop iterations.
      let currentRun: DraftRun | null = null;
      for (let i = 0; i < DEMO_SCRIPT.length; i++) {
        const step = DEMO_SCRIPT[i];
        setDemoStep(i + 1);
        if (step.kind === "draft") {
          const res = await fetch("/api/agent/draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              account: (step.body?.account as typeof DEMO_ACCOUNT) ?? DEMO_ACCOUNT,
              goal: (step.body?.goal as string) ?? "re-engage after the quote",
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          currentRun = json as DraftRun;
          setRun(currentRun);
        } else {
          if (!currentRun) throw new Error("demo script error: outcome before draft");
          const res = await fetch("/api/agent/outcome", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: currentRun.runId, ...(step.body ?? {}) }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          currentRun = json as DraftRun;
          setRun(currentRun);
        }
        // Progressive reveal of the causal chain after each step.
        await loadLearning(DEMO_ACCOUNT.accountId);
        await loadHistory(DEMO_ACCOUNT.accountId);
        loadHealth();
        if (i === 0) setCurve((c) => [...c, CURVE[0]]);
        if (i === 3) setCurve((c) => [...c, CURVE[1]]);
        if (i === 7) setCurve((c) => [...c, CURVE[2]]);
        await new Promise((r) => setTimeout(r, 600)); // beat between steps
      }
      setDemoStep(DEMO_SCRIPT.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(false);
    }
  }

  // Cross-run learning arc, from the /api/runs audit trail (oldest first).
  const loadHistory = useCallback(async (accountId: string) => {
    try {
      const res = await fetch(`/api/runs?accountId=${encodeURIComponent(accountId)}`);
      if (!res.ok) return;
      const json = await res.json();
      const rows: HistoryRow[] = (json.runs ?? []).map(
        (r: {
          runId: string;
          createdAt: string;
          decision?: { selectedStrategy?: string; confidence?: number } | null;
          outcome?: { outcome: string; feedback?: string } | null;
          learning?: {
            learningDelta?: { mentalModelNote?: string } | null;
            observationsConsidered?: unknown[] | null;
          } | null;
          recalledMemories?: unknown[] | null;
        }) => ({
          runId: r.runId,
          createdAt: r.createdAt,
          selectedStrategy: r.decision?.selectedStrategy ?? null,
          confidence: r.decision?.confidence ?? null,
          outcome: r.outcome?.outcome ?? null,
          feedback: r.outcome?.feedback ?? null,
          learningNote: r.learning?.learningDelta?.mentalModelNote ?? null,
          recalledCount: r.recalledMemories?.length ?? 0,
          beliefsConsulted: r.learning?.observationsConsidered?.length ?? 0,
        })
      );
      rows.reverse(); // oldest first: the loop reads top-to-bottom
      setHistory(rows);
    } catch {
      /* history panel is non-critical for the demo flow */
    }
  }, []);

  // Learning-layer inspector: consolidated beliefs + account mental model.
  const loadLearning = useCallback(async (accountId: string) => {
    try {
      const [obsRes, mmRes] = await Promise.all([
        fetch(`/api/memory/observations?accountId=${encodeURIComponent(accountId)}`),
        fetch(`/api/memory/mental-model?accountId=${encodeURIComponent(accountId)}`),
      ]);
      if (obsRes.ok) {
        const json = await obsRes.json();
        setObservations(json.observations ?? []);
      }
      if (mmRes.ok) {
        const json = await mmRes.json();
        setMentalModel(json.model ?? null);
      }
    } catch {
      /* learning panel is non-critical for the demo flow */
    }
  }, []);

  const decision = run?.decision;
  const chain = run
    ? [
        { label: "Situation", done: true },
        { label: `Recalled (${run.recalledMemories.length})`, done: run.recalledMemories.length > 0 },
        {
          label: `Beliefs (${run.learning?.observationsConsidered.length ?? 0})`,
          done: (run.learning?.observationsConsidered.length ?? 0) > 0,
        },
        { label: "Decision", done: true },
        { label: run.outcome ? `Outcome: ${run.outcome.outcome}` : "Outcome", done: Boolean(run.outcome) },
        {
          label: run.learning?.learningDelta ? "Learned" : "Learning",
          done: Boolean(run.learning?.learningDelta),
        },
      ]
    : [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 text-zinc-900 dark:text-zinc-100">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">FollowUp Copilot</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            A sales follow-up agent that decides with its experience — every decision shows what it
            remembered, why, and how the outcome changed its future behavior.
          </p>
        </div>
        {health && (
          <div className="flex items-center gap-2 text-xs">
            <Badge
              tone={health.memoryMode === "hindsight-cloud" ? "good" : "warn"}
              label={`memory: ${health.memoryMode}`}
            />
            <Badge tone={health.llmMode === "live" ? "good" : "warn"} label={`llm: ${health.llmMode}`} />
            <Badge label={`runs: ${health.stats.runs}`} />
          </div>
        )}
      </header>

      {health?.warnings?.length ? (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {health.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}

      {/* One-click judge demo: the scripted arc through the REAL pipeline. */}
      <div className="mb-6 rounded-xl border-2 border-blue-200 bg-blue-50/60 p-4 dark:border-blue-800 dark:bg-blue-950/30">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Watch the agent learn (60-second guided demo)</p>
            <p className="text-xs text-zinc-600 dark:text-zinc-300">
              One account (synthetic data): follow-up → no reply → learning → changed strategy → reply → contradiction →
              uncertainty-aware decision. Runs the real pipeline — nothing is scripted except the inputs.
            </p>
          </div>
          <button
            onClick={runLearningDemo}
            disabled={demoBusy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {demoBusy ? `Demo running… (step ${demoStep}/${DEMO_SCRIPT.length})` : "▶ Run Learning Demo"}
          </button>
        </div>
        {demoStep >= 0 && (
          <p className="mt-2 text-xs text-blue-700 dark:text-blue-300">
            {demoStep === 0
              ? "Resetting demo state…"
              : demoStep <= DEMO_SCRIPT.length
                ? `Step ${demoStep}/${DEMO_SCRIPT.length}: ${DEMO_SCRIPT[demoStep - 1]?.label ?? ""}`
                : "Demo complete — inspect the panels below and the learning arc above."}
          </p>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {/* Causal chain strip: where this run is in the learning loop */}
      {run && (
        <div className="mb-6 flex flex-wrap items-center gap-1 text-xs">
          {chain.map((c, i) => (
            <span key={c.label} className="flex items-center gap-1">
              {i > 0 && <span className="text-zinc-400">→</span>}
              <span
                className={`rounded-full px-2 py-1 font-medium ${
                  c.done
                    ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
              >
                {c.label}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Learning progress: qualitative phases + metrics derived ONLY from
          stored run data (recalled counts, failed attempts, contradictions). */}
      {curve.length > 0 && (
        <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Learning progress — how each interaction changed
          </h2>
          <ol className="space-y-2 text-sm">
            {curve.map((c, i) => {
              const failedAttempts = (history ?? []).filter((h) => h.outcome === "no_reply" || h.outcome === "bounced").length;
              const contradictions = (observations ?? []).filter((o) => o.contradictingEvidence.length > 0).length;
              const metric =
                i === 0
                  ? `decided with ${(history ?? []).slice(-1)[0]?.recalledCount ?? 0} recalled memories and ${(history ?? []).slice(-1)[0]?.beliefsConsulted ?? 0} learned beliefs`
                  : i === 1
                    ? `remembered from ${failedAttempts} previous failed interaction${failedAttempts === 1 ? "" : "s"}`
                    : `conflicting evidence found on ${contradictions} belief${contradictions === 1 ? "" : "s"} — held as contested, not overwritten`;
              return (
                <li key={c.label} className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                  <span className="font-medium text-blue-700 dark:text-blue-300">{c.label}</span>
                  <span className="text-zinc-400">—</span>
                  <span>{metric}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* Cross-run learning arc: how each outcome changed the next decision */}
      {history && history.length > 0 && (
        <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Learning arc across runs — decision → outcome → learned → next decision
          </h2>
          <ol className="space-y-2 text-sm">
            {history.map((h, i) => (
              <li key={h.runId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                <span className="font-medium text-zinc-500">RUN {i + 1}</span>
                <span className="text-zinc-400">decided:</span>
                <span>{h.selectedStrategy ?? "(strategy not recorded)"}</span>
                {h.confidence !== null && (
                  <span className="text-xs text-zinc-400">[confidence {h.confidence.toFixed(2)}]</span>
                )}
                {h.outcome && (
                  <>
                    <span className="text-zinc-400">→ outcome:</span>
                    <span className="font-medium">{h.outcome.replace("_", " ")}</span>
                    {h.feedback && <span className="text-xs text-zinc-500">— “{h.feedback}”</span>}
                  </>
                )}
                {h.learningNote && (
                  <>
                    <span className="text-zinc-400">→ learned:</span>
                    <span className="text-blue-700 dark:text-blue-300">{h.learningNote}</span>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* 1 · Current situation (input) */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            1 · Current situation
          </h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Account ID" value={account.accountId} onChange={(v) => setAccount({ ...account, accountId: v })} />
            <Field label="Company" value={account.company} onChange={(v) => setAccount({ ...account, company: v })} />
            <Field label="Contact" value={account.contactName} onChange={(v) => setAccount({ ...account, contactName: v })} />
            <Field label="Role" value={account.contactRole} onChange={(v) => setAccount({ ...account, contactRole: v })} />
          </div>
          <div className="mt-3">
            <Field
              label="AE notes — what is happening right now"
              value={account.situationNotes}
              onChange={(v) => setAccount({ ...account, situationNotes: v })}
              textarea
            />
          </div>
          <div className="mt-3">
            <Field label="Objective" value={goal} onChange={setGoal} />
          </div>
          <button
            onClick={draft}
            disabled={busy !== null}
            className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === "draft" ? "Deciding…" : "Ask the agent to decide"}
          </button>
          <button
            onClick={resetDemo}
            disabled={busy !== null || resetting}
            className="mt-2 w-full rounded-lg border border-zinc-300 px-4 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {resetting ? "Resetting…" : "Reset demo state (fresh start)"}
          </button>
        </section>

        {/* 2 · Agent decision (the hero) */}
        <section className="rounded-xl border-2 border-blue-200 bg-white p-5 dark:border-blue-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-300">
            2 · Agent decision
          </h2>
          {!run || !decision ? (
            <p className="text-sm text-zinc-500">No decision yet. Describe a situation and let the agent decide.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs uppercase text-zinc-400">Decision</p>
                <p className="text-base font-semibold">{decision.selectedStrategy}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {run.draft.strategyLabels.map((s) => (
                  <span key={s} className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    {s}
                  </span>
                ))}
              </div>
              <div>
                <p className="text-xs uppercase text-zinc-400">
                  Confidence ({decision.confidence.toFixed(2)}) — from evidence actually used
                </p>
                <div className="mt-1 h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className="h-2 rounded-full bg-blue-600"
                    style={{ width: `${Math.round(decision.confidence * 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <p className="text-xs uppercase text-zinc-400">Why (reasoning factors)</p>
                <ul className="mt-1 space-y-1">
                  {decision.reasoningFactors.length === 0 && (
                    <li className="italic text-zinc-500">No influencing factors — a fresh decision.</li>
                  )}
                  {decision.reasoningFactors.map((f, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${DIRECTION_TONE[f.direction] ?? "bg-zinc-100 text-zinc-600"}`}>
                        {f.direction} · {f.source}
                      </span>
                      <span>
                        {f.statement}
                        {f.refId && <span className="ml-1 text-zinc-400">[{f.refId.slice(0, 18)}…]</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {decision.constraints.length > 0 && (
                <div>
                  <p className="text-xs uppercase text-zinc-400">Constraints from learned experience</p>
                  <ul className="list-disc pl-5">
                    {decision.constraints.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {decision.uncertainties.length > 0 && (
                <div>
                  <p className="text-xs uppercase text-zinc-400">Uncertainty the agent is carrying</p>
                  <ul className="list-disc pl-5 text-amber-700 dark:text-amber-300">
                    {decision.uncertainties.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <p className="text-xs uppercase text-zinc-400">Expected outcome</p>
                <p>{decision.expectedOutcome}</p>
              </div>
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer">Show the draft (the action taken)</summary>
                <p className="mt-2 font-medium text-zinc-700 dark:text-zinc-200">{run.draft.subject}</p>
                <p className="whitespace-pre-wrap">{run.draft.body}</p>
              </details>
            </div>
          )}
        </section>

        {/* 3 · Experience used */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            3 · Experience the decision used (recalled — not learned)
          </h2>
          {!run ? (
            <p className="text-sm text-zinc-500">No run yet.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs uppercase text-zinc-400">
                  Episodic memories recalled from Hindsight ({run.recalledMemories.length}, source: {run.memorySource})
                </p>
                {run.recalledMemories.length === 0 ? (
                  <p className="italic text-zinc-500">None — first interaction with this account, the agent is on its own.</p>
                ) : (
                  <ul className="list-disc pl-5">
                    {run.recalledMemories.map((m) => (
                      <li key={m.id}>
                        <span className="mr-1 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {m.type === "observation" ? "belief" : "experience"}
                        </span>
                        <span className="mr-1 font-mono text-[10px] text-zinc-400">{m.id.slice(0, 12)}…</span>
                        {m.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-xs uppercase text-zinc-400">How each memory influenced the decision</p>
                {run.memoryUsage.length === 0 ? (
                  <p className="italic text-zinc-500">Memory was recalled but did not alter this decision.</p>
                ) : (
                  <ul className="list-disc pl-5">
                    {run.memoryUsage.map((u) => (
                      <li key={u.memoryId}>
                        <span className="font-medium">{u.effect}</span>{" "}
                        <span className="text-zinc-500">({u.relevance})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {run.learning?.observationsConsidered.length ? (
                <div>
                  <p className="text-xs uppercase text-zinc-400">Learned beliefs consulted</p>
                  <ul className="list-disc pl-5">
                    {run.learning.observationsConsidered.map((u) => (
                      <li key={u.observationId}>
                        <span className="font-medium">{u.influence}</span>{" "}
                        <span className="text-zinc-500">(belief @ {u.confidence.toFixed(2)})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </section>

        {/* 4 · Outcome → learning */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            4 · Report outcome → what the agent learned
          </h2>
          {!run ? (
            <p className="text-sm text-zinc-500">Decide first.</p>
          ) : run.outcome ? (
            <div className="space-y-3 text-sm">
              <p>
                Outcome: <span className="font-medium">{run.outcome.outcome}</span>
                {run.outcome.feedback && <span className="text-zinc-500"> — “{run.outcome.feedback}”</span>}
              </p>
              <p className="text-xs text-zinc-500">
                Retained {run.retainedMemoryIds.length} experience memor{run.retainedMemoryIds.length === 1 ? "y" : "ies"} and
                consolidated the evidence.
              </p>
              {run.learning?.learningDelta && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/40">
                  <p className="text-xs uppercase text-zinc-400">Learning delta</p>
                  <p className="mt-1">
                    <span className="font-medium">Learned:</span> {run.learning.learningDelta.mentalModelNote}
                  </p>
                  {run.beforeAfter && (
                    <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
                      <div className="rounded bg-white p-2 dark:bg-zinc-900">
                        <p className="font-medium uppercase text-zinc-400">Before this outcome</p>
                        <ul className="mt-1 list-disc pl-4">
                          {run.beforeAfter.before.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="rounded bg-white p-2 dark:bg-zinc-900">
                        <p className="font-medium uppercase text-zinc-400">After this outcome</p>
                        <ul className="mt-1 list-disc pl-4">
                          {run.beforeAfter.after.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                  <p className="mt-2 text-zinc-500">
                    Next drafts for this account consult the refreshed mental model — that is how this
                    outcome changes future behavior.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <Field label="Optional feedback — explain why (this becomes a directive memory)" value={feedback} onChange={setFeedback} textarea />
              <div className="flex flex-wrap gap-2">
                {["replied", "no_reply", "bounced", "meeting_booked"].map((o) => (
                  <button
                    key={o}
                    onClick={() => reportOutcome(o)}
                    disabled={busy !== null}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {o.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 5 · What the agent believes */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 md:col-span-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            5 · What the agent believes (learned from outcomes — not recalled)
          </h2>
          {!observations?.length ? (
            <p className="text-sm italic text-zinc-500">
              No consolidated beliefs yet — report an outcome and evidence-backed ones will form here.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {observations.map((o) => (
                <li key={o.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={o.status === "active" ? "good" : o.status === "contested" ? "warn" : undefined}
                      label={o.status}
                    />
                    <span className="text-xs text-zinc-400">{o.patternKey}</span>
                  </div>
                  <p className="mt-1">{o.statement}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    confidence {o.confidence.toFixed(2)} · evidence: {o.supportingEvidence.length} supporting /{" "}
                    {o.contradictingEvidence.length} contradicting · updated {o.updatedAt.slice(0, 10)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {mentalModel && (
            <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/60">
              <p className="text-xs uppercase text-zinc-400">
                Mental model used before acting {mentalModel.nativeContent ? "(hindsight-native)" : "(local)"}
              </p>
              {mentalModel.beliefs.length === 0 ? (
                <p className="mt-1 italic text-zinc-500">The agent holds no beliefs about this account yet.</p>
              ) : (
                <ul className="mt-1 list-disc pl-5">
                  {mentalModel.beliefs.map((b) => (
                    <li key={b.statement}>
                      {b.statement}{" "}
                      <span className="text-zinc-400">
                        [{b.confidence.toFixed(2)}, {b.evidenceCount} evidence]
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {mentalModel.uncertainties.length > 0 && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  Uncertain: {mentalModel.uncertainties.join(" | ")}
                </p>
              )}
              {mentalModel.approachesToRepeat.length > 0 && (
                <p className="mt-1 text-xs text-green-700 dark:text-green-300">
                  Repeat: {mentalModel.approachesToRepeat.join(" | ")}
                </p>
              )}
              {mentalModel.approachesToAvoid.length > 0 && (
                <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                  Avoid: {mentalModel.approachesToAvoid.join(" | ")}
                </p>
              )}
            </div>
          )}
        </section>

        {/* How Hindsight powers this agent — plain-language explainer (Phase F). */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 md:col-span-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            How Hindsight powers this agent
          </h2>
          <div className="grid gap-3 text-xs md:grid-cols-3">
            {[
              {
                t: "RETAIN",
                d: "After every outcome, the agent stores what happened and what resulted in the Hindsight memory bank — per account, traceable to the run that produced it.",
              },
              {
                t: "RECALL",
                d: "Before every decision, it retrieves relevant previous experience for THIS account and cites the memories that changed its recommendation.",
              },
              {
                t: "REFLECT / LEARN",
                d: "Repeated outcomes are consolidated into beliefs with evidence on both sides — friction signals and successes — never a single event turned into a rule.",
              },
              {
                t: "MENTAL MODEL",
                d: "Accumulated beliefs become an account-level model consulted before acting: what to repeat, what to avoid, what is still uncertain.",
              },
              {
                t: "DECIDE",
                d: "The next decision is made with that experience: strategies change, constraints appear, and confidence reflects the evidence actually used.",
              },
              {
                t: "OUTCOME → EVIDENCE",
                d: "The result becomes new evidence. Successes against a belief contest it instead of being silently absorbed — history is preserved, never erased.",
              },
            ].map((c) => (
              <div key={c.t} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
                <p className="font-mono text-[10px] font-semibold text-blue-700 dark:text-blue-300">{c.t}</p>
                <p className="mt-1 text-zinc-700 dark:text-zinc-300">{c.d}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Ordinary conversation history alone cannot do this: chat history stores text, not evidence-weighted beliefs,
            and has no consolidation step that changes future behavior. Provider status: {health?.memoryMode === "hindsight-cloud" ? "Hindsight Cloud (live, connectivity verified this request)" : "local file-backed fallback — Hindsight Cloud not configured in this environment"}.
          </p>
        </section>

        {/* 6 · Episodic memory inspector (audit view) */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 md:col-span-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            6 · Episodic memory inspector (audit view)
          </h2>
          <div className="flex gap-2">
            <input
              value={inspectQuery}
              onChange={(e) => setInspectQuery(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            />
            <button
              onClick={inspect}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Inspect
            </button>
          </div>
          {inspected && (
            <div className="mt-3 text-sm">
              <p className="text-xs text-zinc-400">{inspected.memories.length} memories found</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {inspected.memories.map((m) => (
                  <li key={m.id}>{m.text}</li>
                ))}
              </ul>
              {inspected.memories.length === 0 && (
                <p className="mt-1 italic text-zinc-500">Empty — the agent knows nothing yet.</p>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="mt-8 text-center text-xs text-zinc-400">
        Decision loop: situation → recall → decide (with experience) → act → outcome → learn → behave
        differently next time. Every step is auditable.
      </footer>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone?: "good" | "warn" }) {
  const cls =
    tone === "good"
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : tone === "warn"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  return <span className={`rounded-full px-2 py-1 font-medium ${cls}`}>{label}</span>;
}

function Field({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs uppercase text-zinc-400">{label}</span>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
      )}
    </label>
  );
}
