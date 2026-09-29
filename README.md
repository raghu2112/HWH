# FollowUp Copilot — a sales agent that decides with its experience

**For judges, in one minute:** a B2B sales rep re-sends the same generic
follow-ups because nothing remembers what happened last time. This agent
drafts every follow-up **with its accumulated account experience**: it recalls
what happened before from Hindsight, consults beliefs it formed from past
outcomes, shows you exactly which experience changed its decision, and updates
what it believes after every outcome — including keeping contradictions
instead of overwriting them. Run the 60-second demo below and watch the
strategy change between Run 1 and Run 2 for reasons the agent can cite.

Built on [Hindsight](https://github.com/vectorize-io/hindsight) (Vectorize)
for agent memory: `retain` / `recall` / `reflect` over memory banks. Reasoning
runs on Groq (`openai/gpt-oss-120b` by default, configurable via `GROQ_MODEL`).

## The problem — why ordinary stateless AI fails here

An AE's follow-up emails are generic because nothing remembers what happened
last time. Every rep re-learns the same account lessons: which topic stalled
the deal, which angle earned a reply, when pricing talk kills momentum. A
stateless LLM re-derives the same generic answer every time — it cannot get
better at *this account* no matter how many times it interacts with it.

This agent closes that loop:

```
situation → recall experience → decide (with that experience) → act
     ↑                                                      ↓
behave differently next time ← update mental model ← outcome + feedback
```

Every decision is auditable: what it remembered, why those memories were
relevant, how they changed the decision, what happened, what it learned, and
how that learning changes the next decision.

## Quick start

```bash
npm install
npm run dev                  # http://localhost:3000 — zero keys required
node scripts/demo-loop.mjs   # deterministic learning-arc demo (separate terminal)
```

Two independent upgrades happen via `.env.local`:

| Key | Effect when set |
|---|---|
| `HINDSIGHT_API_KEY` | memory switches from local file-backed store to **Hindsight Cloud** (`HINDSIGHT_BASE_URL`, `HINDSIGHT_BANK_ID` optional) |
| `GROQ_API_KEY` | reasoning switches from the deterministic mock LLM to **Groq** (OpenAI-compatible endpoint) — `GROQ_MODEL` optional, defaults to `openai/gpt-oss-120b` |

Sign up for Hindsight Cloud: https://hindsight.vectorize.io/pricing

## How Hindsight is used (explicitly)

- **Retain** — after every outcome, the agent writes the experience back into
  the Hindsight bank (what was sent, what happened, the AE's feedback, the run
  id that produced it) so the event is recallable forever.
- **Recall** — before every decision, the agent queries the bank with an
  account-scoped, strict tag filter (`all_strict`), so only THIS account's
  experience can reach the reasoning step.
- **Influence** — every recalled memory that changes the draft is cited by id
  in the decision's reasoning factors; hallucinated references are rejected by
  validation, so the chain from memory → decision is enforced, not decorative.
- **Learn** — outcomes are consolidated into evidence-backed beliefs; those
  beliefs are re-retained into Hindsight as tagged memories and drive the next
  decision's constraints.

## Why chat history and RAG are not enough

Chat history stores text; it has no notion of evidence, confidence, or
contradiction, so a failed approach and a successful one look identical.
Retrieval-augmented generation (RAG) fetches relevant *documents* at question
time, but nothing accumulates: the same failure next quarter retrieves the
same content and produces the same mistake. This agent instead runs a
consolidation step over outcomes — evidence accrues, beliefs strengthen or get
contested, and the next decision is measurably different. That loop is the
product.

## How the agent learns (two layers)

**Layer 1 — episodic experience.** Every outcome is retained as structured
memory: what was tried, what happened, the AE's feedback, which run produced
it. This answers *"what happened before?"*

**Layer 2 — consolidated knowledge.** Outcomes flow into a deterministic
consolidation engine (no LLM dependency):

- **Observations (beliefs)** — e.g. *"this account shows friction around
  price/budget sensitivity"*. Every belief carries supporting AND contradicting
  evidence, a confidence (evidence-weighted, diminishing returns, capped 0.9),
  and a status: `contested` → `active` (needs ≥2 independent supporting
  outcomes) → `retired` (when success evidence dominates).
- **Mental model** — the per-account summary consulted BEFORE acting: beliefs,
  uncertainties, approaches to repeat, approaches to avoid.

**Contradiction handling.** Successes are never silently absorbed: a success
against an active belief **contests** it (confidence drops, contradicting
evidence is recorded) and the next decision explicitly carries the conflict —
verify, don't assume. Beliefs are retired only when success evidence dominates,
never deleted.

## The decision object

Each run persists a structured `AgentDecision`: situation, objective,
constraints from learned experience, uncertainties, reasoning factors
(each tied to the memory/observation that produced it), selected strategy,
confidence (derived from evidence actually used), the action, and the expected
outcome. After the outcome: learning delta + mental-model before/after.
The UI renders this chain; `/api/runs` exposes it.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | memory/LLM mode, Hindsight reachability + config status, run stats |
| `POST /api/agent/draft` | run the decision loop → full auditable run incl. `decision` |
| `POST /api/agent/outcome` | report outcome/feedback → retain + consolidation |
| `GET /api/runs?accountId=` | audit trail: runs, decisions, learning deltas |
| `GET /api/memory/inspect?q=&accountId=` | episodic memories (what happened) |
| `GET /api/memory/observations?accountId=` | consolidated beliefs with evidence |
| `GET /api/memory/mental-model?accountId=` | "what should I already know before acting?" |
| `DELETE /api/demo/reset` | demo hygiene: wipes local runs/memories/beliefs (refuses in cloud mode) |

## Demo (one click, or deterministic script)

**In the UI:** press **“▶ Run Learning Demo”**. It resets state, then executes
the full arc — interaction → outcome → learning → changed strategy → reply →
contradiction → uncertainty-aware decision — through the real endpoints.
Nothing is scripted except the inputs; every decision and learning delta comes
from the actual memory → recall → reasoning → consolidation pipeline. Manual
mode (enter your own situation, decide, report outcomes) remains fully
available.

**From the terminal:** `node scripts/demo-loop.mjs [baseUrl] [--fresh]` runs a
five-interaction learning arc against one account and prints the causal chain
of each decision from actual state. `--fresh` first wipes the local demo state (runs,
memories, learned beliefs) via `DELETE /api/demo/reset`, so a repeat demo can
never be contaminated by stale runs. On Hindsight Cloud, use a fresh
`HINDSIGHT_BANK_ID` for a from-zero demo — cloud experience is never deleted
by the reset route:

1. **RUN 1 — baseline**: no experience → generic strategy → negative outcome →
   a weak, explicitly-unconfirmed pricing belief forms.
2. **RUN 2 — learning**: second failed cycle hardens the belief (contested →
   active) → next decision RECALLS it, changes strategy, defers pricing →
   improved outcome.
3. **RUN 3 — contradiction**: a pricing-led exchange books a meeting → the
   belief flips to contested (not erased) → the next decision carries the
   uncertainty and verifies instead of assuming.

All console output is generated from real application state — nothing scripted.

## What's verified vs. what needs Hindsight Cloud

**Verified locally (deterministic, no keys):**
- the full decision loop, observations, contradiction handling, mental models,
  learning deltas, account isolation, audit trail — 82 tests + demo.

**Verified LIVE against Hindsight Cloud** (`node scripts/hindsight-smoke.mjs`,
opt-in; uses a dedicated scratch bank that is deleted afterwards):
- provider selection, connectivity probe, retain, recall, the
  **memory-changes-the-decision** proof (strategy changed after cloud recall),
  consolidated observations, the native (`native: true`) account mental model,
  cross-account isolation, and inspectability — 12/12 checks.
- `GET /api/health` reports `hindsightReachable: true` only after a real
  `getVersion()` probe — an API key alone never counts as "connected".

If `HINDSIGHT_API_KEY` is unavailable, the smoke exits with code 2 and prints
that live verification is pending — it never fakes a pass.

## Architecture

```
src/
  lib/
    config/env.ts          validated env contract, graceful degradation
    types.ts               loop stages, learning layer, AgentDecision
    memory/
      provider.ts          MemoryProvider interface (Hindsight-first)
      hindsight-provider.ts real Hindsight Cloud implementation
      local-provider.ts    file-backed fallback (same contract, zero keys)
      factory.ts           provider selection
      consolidator.ts      deterministic evidence → observation → mental model
    store/
      runs.ts              audit-trail persistence (runs + outcomes)
      observations.ts      belief ledger (evidence-backed, account-scoped)
    llm/provider.ts        Groq (OpenAI-compatible) live provider + deterministic decision-capable mock
    agent/
      prompts.ts           six labeled prompt sections (episodic ≠ consolidated)
      orchestrator.ts      10-stage decision loop (preserves the 6-stage API)
  app/api/…                HTTP boundary
  components/              decision workspace UI
```

`.data/` (gitignored) holds local run/memory/belief files when running
without Hindsight Cloud.

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (unit tests, no network)
node scripts/demo-loop.mjs        # deterministic multi-run demo
node scripts/verify-ui-demo.mjs   # asserts the exact UI demo sequence, end to end
node scripts/latency-check.mjs    # measures real demo-path latency
node scripts/groq-smoke.mjs       # opt-in live Groq verification (exit 2 if no key)
node scripts/hindsight-smoke.mjs  # opt-in live Hindsight Cloud verification (exit 2 if no key)
```

## Isolation guarantee

Memories, observations, mental models, decisions, and runs are partitioned by
`accountId` at the provider level and enforced in tests: experience gained
with account A never influences a decision for account B.

## Security notes

- `.env.local` is gitignored; no credentials are committed (verified across
  the full git history).
- Credentials are read from `process.env` at runtime, so the deployable build
  output (`.next/server`, `.next/static`) contains no secrets — verified by
  building with and without `.env.local` present and scanning the artifacts.
- Turbopack's **local build cache** (`.next/cache/`) is not deployable output,
  but it can contain `.env.local` values after a keyed build. Never zip,
  upload, or share the `.next` directory; if you archive or hand off the
  project, run `rm -rf .next` first.

## Known limitations

- **Live-path latency (measured, not invented):** with Groq + Hindsight Cloud
  the full five-interaction arc takes ~60–70s wall time (drafts ~5–8s: one
  Groq reasoning call plus Hindsight recall; outcomes ~4.5–13s: synchronous
  Hindsight extraction is what makes the next draft deterministically recall
  the experience). On the local fallback the same arc runs in ~0.4s total.
  For a presentation with live keys, run the demo once before the judges sit
  down, or present on the local fallback — both show the identical causal
  story.
- The consolidation engine is deliberately lexicon-based and deterministic
  (five dimensions: pricing, security, timing, channel, messaging). It is not
  an LLM — by design: learning must not depend on the LLM being available and
  must be reproducible in tests.
- On the local fallback, recall is keyword + recency, not semantic. Hindsight
  Cloud adds semantic, graph, and temporal retrieval when keyed.
- A single outcome can never harden into an active belief (grounding floor of
  two independent supporting outcomes) — so early decisions correctly carry
  uncertainty rather than false confidence.
- `DELETE /api/demo/reset` exists for demo hygiene on the local fallback only;
  it refuses to delete Hindsight Cloud state. For a from-zero cloud demo, use
  a fresh `HINDSIGHT_BANK_ID`.
- All demo data is synthetic (VertexOne Technologies / Ananya Rao). No real
  customer data is used or implied.
