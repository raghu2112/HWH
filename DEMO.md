# Judge Demo Kit — FollowUp Copilot

Everything a presenter needs for the 60-second demonstration and judge Q&A.
Based strictly on implemented, verified behavior — the demo runs the real
pipeline; nothing is scripted except the inputs.

---

## 1. The 60-second demo script

**Setup (before judges sit down):** start the app (`npm run dev`). With live
keys the full arc takes ~60–70s; on the local fallback (~0.4s of compute) the
same causal story plays in seconds. Either way, click **"▶ Run Learning
Demo"** once beforehand so the first click for judges is warm, and use
**Reset demo** for a true from-zero run (local fallback only — the endpoint
refuses to delete Hindsight Cloud state).

The one-click panel walks 9 steps through the real API. Say roughly this:

| Clock | Step | What happens on screen | What to say |
|---|---|---|---|
| 0:00 | Problem (before clicking) | VertexOne account card: ~$240k ARR deal, contact went quiet after the quote | "A sales rep re-sends the same generic follow-up and re-learns account lessons every time. Watch the agent decide from experience instead." |
| 0:10 | Interaction 1 | Decision labeled *generic first-touch check-in* — **recalled memories: 0** | "No relevant experience yet — so the decision is generic." |
| 0:15 | Outcome: no reply | Outcome recorded with AE feedback ("led with pricing right after the quote") | "Real feedback goes in — not just the fact it failed, but why." |
| 0:20 | Interaction 2 + outcome | Second pricing-led attempt fails the same way | "It fails again the same way — evidence is accumulating." |
| 0:25 | Learning | Recalled memories rise (0 → 2), a belief forms, Learning Progress updates | "Hindsight retained both experiences; consolidation formed a belief: pricing-first underperforms for this account." |
| 0:35 | Interaction 3 | **Strategy changes** (pricing-first → operational-value), constraint derived from memory is visible | "The next decision is different because of memory — the constraint comes from learned experience." |
| 0:40 | Outcome: replied | Reply within an hour, asking for the workflow assessment | "The new approach gets a response." |
| 0:45 | Contradiction | CFO asks for the full pricing breakdown; belief flips to **contested** (contradicting evidence: 2), never erased | "Now pricing works — the agent doesn't overwrite the old belief, it marks it contested and carries uncertainty." |
| 0:50 | Interaction 5 | Final decision is uncertainty-aware — **confidence drops to 0.35**, both evidence directions shown | "Mixed evidence lowers confidence instead of flipping to false certainty." |
| 0:55 | Takeaway | Learning-curve panel: generic → personalized → context-aware | "The point isn't that it remembers text — it's that experience changes future decisions." |

**If judges ask to go deeper:** open the Hindsight explainer panel in the UI,
use the memory-inspect box (same recall path the agent uses), or show the
run-history audit trail (every decision with its provenance).

## 2. Judge talk track (five questions)

**1. What problem are you solving?**
B2B sales follow-up. A rep re-sends generic messages and re-learns account
lessons that the team already paid for. FollowUp Copilot keeps per-account
experience and lets it change every future follow-up decision.

**2. Why is Hindsight necessary?**
The learning must survive across sessions and be retrievable by meaning, not
by keyword. Hindsight is the persistent memory layer: every interaction and
every outcome is retained there, recalled before each decision, and
consolidated into beliefs and an account mental model. The same flow is
verified live against Hindsight Cloud, and account isolation (`all_strict`
tags) keeps one account's experience out of another's decisions.

**3. How is this different from normal RAG / chat history?**
Chat history stores what was *said*; RAG retrieves text. Neither learns.
Here, outcomes are captured with feedback, consolidated into evidence-weighted
beliefs (a belief needs more than one supporting outcome to become active),
and the mental model feeds hard constraints and uncertainty into the next
decision. Retrieval is one input; behavior change is the point.

**4. What actually changes after an outcome?**
The strategy choice. In the verified demo: two pricing-led follow-ups get no
reply → the belief "pricing-first underperforms for this account" forms → the
next decision avoids pricing and leads with operational value → the account
replies. Recalled-memory count, factor chips, and the belief panel all show
the causal chain.

**5. What happens when previous learning is contradicted?**
Nothing is erased. The contradicting outcome is retained, the belief is marked
**contested** (or retired once contradicting evidence is strong enough), and
the next decision carries explicit uncertainty — in the demo the final
confidence drops to 0.35 with both evidence directions shown. Under the
grounding floor, a single outcome can never harden into an active belief.

## 3. Hindsight explanation (no source code required)

**Three memory layers, all in Hindsight:**

1. **Episodic experience** — what happened in each interaction (decision,
   context, outcome, feedback), retained per account and traceable to the run
   that produced it.
2. **Consolidated observations/beliefs** — patterns extracted from outcomes:
   which approach dimensions (pricing, security, timing, channel, messaging)
   helped or hurt, with evidence counts and confidence.
3. **Account mental model** — the current picture of the account: active
   beliefs, uncertainties, approaches to repeat and to avoid.

**The flow:** experience → Hindsight memory → outcome captured →
consolidation → belief updated → mental model changes → next decision
consults it → behavior changes.

**Why contradiction handling matters:** a belief from past evidence is a
hypothesis, not permanent truth. When new evidence contradicts it, its status
changes and uncertainty enters the decision instead of the old belief being
blindly repeated — or silently overwritten.

---

*Every claim above corresponds to a check in `scripts/verify-ui-demo.mjs`
(9-step UI replay, ALL CHECKS PASSED) or the live smoke scripts
(`groq-smoke.mjs`, `hindsight-smoke.mjs`).*
