import { getEnv } from "../config/env";
import type { DecisionFactor } from "../types";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  complete(messages: LLMMessage[]): Promise<string>;
  readonly mode: "live" | "mock";
}

/**
 * Live-call timeout (ms). Generous enough for reasoning models on Groq's free
 * tier, tight enough that a hung request cannot stall a live judge demo.
 * Read from env at CONSTRUCTION time so tests can exercise the timeout path.
 */
const DEFAULT_LLM_TIMEOUT_MS = 25_000;
export const LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

/**
 * Groq live provider — Groq exposes an OpenAI-compatible Chat Completions API,
 * so the wire format (including `response_format: json_object` for structured
 * output) is unchanged. The key is sent ONLY in the Authorization header to
 * the Groq endpoint; it is never logged, returned, or serialized.
 */
export class GroqLLMProvider implements LLMProvider {
  readonly mode = "live" as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string }) {
    const env = getEnvSafe();
    this.apiKey = opts?.apiKey ?? env.apiKey ?? "";
    this.baseUrl = opts?.baseUrl ?? env.baseUrl;
    this.model = opts?.model ?? env.model;
    this.timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_LLM_TIMEOUT_MS);
  }

  /** Key-leak guard: accidental serialization of the provider never exposes it. */
  toJSON(): Record<string, unknown> {
    return { mode: this.mode, model: this.model, baseUrl: this.baseUrl, apiKey: "[REDACTED]" };
  }

  /**
   * Defense-in-depth: provider errors must never carry credential material
   * into logs, API responses, or the UI (some upstream errors echo request
   * headers). Key-shaped substrings are stripped before the error escapes.
   */
  private static sanitized(message: string): string {
    return message
      .replace(/gsk_[A-Za-z0-9]+/g, "[REDACTED]")
      .replace(/Bearer\s+[^\s",)]+/gi, "Bearer [REDACTED]")
      .replace(/hsk_[A-Za-z0-9_]+/g, "[REDACTED]");
  }

  async complete(messages: LLMMessage[]): Promise<string> {
    // Transient-failure policy: 429 (rate limit) and 503 are retried with
    // backoff — Groq's free tier allows ~8k tokens/minute, so back-to-back
    // drafts in a live demo can legitimately 429. Bounded (2 retries, ≤15s
    // wait) so the demo stays responsive; network-level errors fail fast
    // since the per-attempt timeout already bounds them.
    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        // Controlled timeout: a judge demo must never hang on one transient
        // provider stall. AbortError surfaces as the same controlled error path
        // as any other network failure.
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0.4,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        const reason = timedOut
          ? `no response within ${Math.round(this.timeoutMs / 1000)}s`
          : err instanceof Error
            ? err.message
            : String(err);
        // Controlled, clear error. Never includes the key.
        throw new Error(
          GroqLLMProvider.sanitized(
            `Groq call failed: could not reach ${this.baseUrl} (${reason})`
          )
        );
      }
      if (res.status === 429 || res.status === 503) {
        const body = await res.text().catch(() => "");
        lastError = new Error(
          GroqLLMProvider.sanitized(`Groq call failed (${res.status}): ${body.slice(0, 300)}`)
        );
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = Math.min(Number(res.headers.get("retry-after")) || 10, 15);
          console.warn(
            `[groq] ${res.status} — retrying in ${retryAfter}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          GroqLLMProvider.sanitized(`Groq call failed (${res.status}): ${text.slice(0, 300)}`)
        );
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content ?? "";
    }
    throw lastError ?? new Error("Groq call failed");
  }
}

/**
 * Deterministic mock: demonstrates the two-layer learning system without any
 * API key. Behavior changes based on recalled memories AND consolidated
 * observations, including acknowledging contradictions — so the
 * "generic → learned → contradiction-aware" progression is reproducible in
 * tests and demos.
 */
export class MockLLMProvider implements LLMProvider {
  readonly mode = "mock" as const;

  async complete(messages: LLMMessage[]): Promise<string> {
    const user = messages.find((m) => m.role === "user")?.content ?? "";

    // Section-based parsing of the assembled prompt (see buildDraftPrompt).
    // Sections are blank-line-separated blocks whose first line is "NAME: ...".
    // Matching against block starts (not `$`-terminated regexes) keeps
    // multi-line sections intact.
    const blocks = user.split(/\n[ \t]*\n/);
    const section = (name: string): string => {
      const header = new RegExp(`^${name}[^\\n]*:`);
      const block = blocks.find((b) => header.test(b));
      if (!block) return "";
      return block.replace(new RegExp(`^${name}[^\\n]*:\\n?`), "").trim();
    };

    const memoriesText = section("RELEVANT EPISODIC MEMORIES");
    const obsText = section("CONSOLIDATED OBSERVATIONS");

    const situation = section("CURRENT REQUEST");
    const company = capture(situation, /Account:\s*(.+?)\s+\(id:/) ?? capture(situation, /Account:\s*(.+)/);
    const contact = capture(situation, /Contact:\s*(.+?)\s*\(/) ?? "there";

    const strategyLabels: string[] = [];
    const memoryUsage: Array<{ memoryId: string; relevance: string; effect: string }> = [];
    const observationUsage: Array<{ observationId: string; influence: string }> = [];

    // ── Observations drive strategy when present ────────────────────────────
    const obsLines = obsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- ["));

    const bodyOpeners: string[] = [];
    for (const line of obsLines) {
      const obsId = line.match(/\(id=(\S+?),/)?.[1] ?? line.slice(0, 24);
      const idMatch = line.match(/\[(active|contested|retired)\]/);
      const contradicting = Number(line.match(/\/\s*(\d+)\s+contradicting/)?.[1] ?? 0);
      const supporting = Number(line.match(/evidence:\s*(\d+)\s+supporting/)?.[1] ?? 0);
      const statement = line.replace(/^-\s*\[(active|contested|retired)\][^)]*\)\s*/, "");
      const isContested = idMatch?.[1] === "contested";
      const aboutPricing = /price|pricing|budget|cost/i.test(statement);
      const aboutSecurity = /security|compliance|soc\s?2/i.test(statement);

      if (isContested && contradicting > 0) {
        // Contradiction handling: acknowledge, don't blindly reuse.
        strategyLabels.push("acknowledge-contradiction");
        observationUsage.push({
          observationId: obsId,
          influence:
            "previous belief is contradicted by newer success; verifying directly instead of assuming friction",
        });
        bodyOpeners.push(
          `I want to make sure I'm not relying on outdated assumptions — I'd like to confirm what actually matters to your team right now.`
        );
        continue;
      }

      if (isContested && contradicting === 0 && supporting <= 1) {
        // Weak single-example belief: hold it loosely — verify, don't assert.
        strategyLabels.push("hold-lightly");
        observationUsage.push({
          observationId: obsId,
          influence:
            "weak single-example belief; probing the account directly instead of assuming friction",
        });
        continue; // no opener injection; keep the draft natural
      }

      if (aboutPricing) {
        strategyLabels.push("defer-pricing");
        observationUsage.push({
          observationId: obsId,
          influence: "deferring pricing-led ask; leading with value and a small next step",
        });
        bodyOpeners.push("Rather than jumping into pricing, I'd like to focus on where your team sees the most value first.");
      } else if (aboutSecurity) {
        strategyLabels.push("security-first-cta");
        observationUsage.push({
          observationId: obsId,
          influence: "leading with the security review path, since that engaged this account before",
        });
        bodyOpeners.push("Happy to run the security review your team asked about as the next step.");
      } else {
        strategyLabels.push("observation-informed");
        observationUsage.push({
          observationId: obsId,
          influence: "incorporating what we learned from previous interactions",
        });
      }
    }

    // ── Episodic memory influences tone/history references ──────────────────
    const memLines = memoriesText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- (id="));
    for (const line of memLines) {
      const id = line.match(/\(id=(\S+)/)?.[1] ?? "unknown";
      const text = line.replace(/^\s*-\s*\(id=\S+[^)]*\)\s*/, "").trim();
      const t = text.toLowerCase();
      if (t.includes("outcome: no_reply") || t.includes("outcome: bounced")) {
        strategyLabels.push("avoid-repeat-failure");
        memoryUsage.push({
          memoryId: id,
          relevance: "previous attempt with this contact did not land",
          effect: "changed opening to acknowledge prior silence and soften the ask",
        });
        bodyOpeners.push("I know my last note may have landed at a busy time — no pressure to reply to that one.");
      } else if (t.includes("outcome: replied") || t.includes("outcome: meeting_booked")) {
        strategyLabels.push("build-on-success");
        memoryUsage.push({
          memoryId: id,
          relevance: "this approach previously earned a reply",
          effect: "kept the angle that worked and escalated the call-to-action",
        });
        bodyOpeners.push("Last time we spoke, this resonated — so let's build on it.");
      }
    }

    // ── Compose deterministic draft ────────────────────────────────────────
    if (obsLines.length === 0 && memLines.length === 0) {
      strategyLabels.push("generic-first-touch");
    }

    const body = [
      `Hi ${contact},`,
      ...(bodyOpeners.length
        ? bodyOpeners
        : [
            `We left off with your team evaluating next steps${company ? ` at ${company}` : ""}.`,
            "Happy to share a short summary tailored to your team.",
          ]),
      "Would a 20-minute call this week work?",
    ].join(" ");

    const subject =
      obsLines.some((l) => /price|pricing|budget/i.test(l))
        ? `Next steps for ${company ?? "your team"}`
        : memLines.length > 0 || obsLines.length > 0
          ? `Following up — ${company ?? "next steps"}`
          : `Quick follow-up from our team`;

    // ── Decision fields: every value derived from the prompt state above ──
    const hasActiveBelief = obsLines.some((l) => l.includes("[active]"));
    const hasContradictedBelief = obsLines.some((l) => {
      const m = l.match(/\/\s*(\d+)\s+contradicting/);
      return m !== null && Number(m?.[1]) > 0;
    });

    const reasoningFactors: DecisionFactor[] = [];
    for (const u of observationUsage) {
      reasoningFactors.push({
        source: "observation",
        refId: u.observationId,
        statement: u.influence,
        direction:
          u.influence.includes("contradict") || u.influence.includes("weak single-example")
            ? "uncertainty"
            : "pushed toward",
      });
    }
    for (const u of memoryUsage) {
      reasoningFactors.push({
        source: "memory",
        refId: u.memoryId,
        statement: u.effect,
        direction: "pushed toward",
      });
    }
    const aeNotes = capture(situation, /AE notes:\s*(.+)/) ?? "no additional situation notes";
    reasoningFactors.push({
      source: "situation",
      statement: `Current AE input: ${aeNotes}`,
      direction: "pushed toward",
    });

    const strategyOneLiner: Record<string, string> = {
      "generic-first-touch": "Generic first-touch check-in (no relevant experience yet)",
      "defer-pricing": "Value-first follow-up that defers the pricing conversation",
      "security-first-cta": "Lead with the security review path this account engaged with before",
      "acknowledge-contradiction":
        "Conflict-aware check-in that verifies current priorities instead of assuming friction",
      "hold-lightly": "Probe the account's actual priorities before acting on a weak belief",
      "avoid-repeat-failure": "Softened re-engagement after a previous non-response",
      "build-on-success": "Build on the angle that earned a reply before",
      "observation-informed": "Experience-informed follow-up",
    };
    const labels = [...new Set(strategyLabels)];
    const selectedStrategy =
      strategyOneLiner[labels[0] ?? ""] ?? `Experience-informed follow-up (${labels.join(", ")})`;

    // Confidence tracks evidence strength — never asserted, always derived.
    let confidence = 0.4; // generic baseline: no learned basis
    if (memoryUsage.length > 0) confidence += 0.1;
    if (hasActiveBelief) confidence += 0.15;
    if (hasContradictedBelief) confidence -= 0.15;
    confidence = Math.max(0.2, Math.min(0.85, confidence));

    const expectedOutcome = hasContradictedBelief
      ? "Uncertain — this draft aims to verify the account's current priorities rather than predict a reply."
      : hasActiveBelief
        ? "A reply is more likely with the pricing-led ask removed; goal is reopening the conversation."
        : memoryUsage.length > 0
          ? "Re-engagement informed by previous outreach; moderate chance of a reply."
          : "Modest chance of a reply from a standard check-in; no learned basis to expect more.";

    return JSON.stringify({
      subject,
      body,
      strategyLabels: labels,
      selectedStrategy,
      reasoningFactors,
      confidence,
      expectedOutcome,
      memoryUsage,
      observationUsage,
    });
  }
}

function capture(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1]?.trim() || undefined;
}

function getEnvSafe(): { apiKey?: string; baseUrl: string; model: string } {
  const env = getEnv();
  return { apiKey: env.llmApiKey, baseUrl: env.llmBaseUrl, model: env.llmModel };
}
