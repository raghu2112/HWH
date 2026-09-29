import type {
  AccountContext,
  AccountMentalModel,
  DecisionFactor,
  DraftPlan,
  FollowUpDraft,
  MemoryUsage,
  Observation,
  RecalledMemory,
  RetainedMemory,
} from "../types";
import { renderLearningSections } from "../memory/consolidator";

/**
 * Prompt assembly for the follow-up draft LLM call.
 *
 * Architecture rule enforced here: the reasoning context is composed of
 * SEPARATE, labeled sections — never a blended conversation dump. Episodic
 * memory ("what happened") and consolidated knowledge ("what the agent
 * believes") are distinct inputs with distinct epistemics.
 *
 * Sections (in order):
 *   1. CURRENT REQUEST
 *   2. RELEVANT EPISODIC MEMORIES
 *   3. CONSOLIDATED OBSERVATIONS
 *   4. ACCOUNT MENTAL MODEL
 *   5. UNCERTAINTIES / CONTRADICTIONS
 *   6. REQUIRED DECISION
 */
export function buildDraftPrompt(input: {
  account: AccountContext;
  goal?: string;
  memories: RecalledMemory[];
  observations: Observation[];
  mentalModel: AccountMentalModel;
}): { system: string; user: string } {
  const { account, goal, memories, observations, mentalModel } = input;

  const system = [
    "You are FollowUp Copilot, an AI sales follow-up assistant for a B2B SaaS Account Executive.",
    "You draft short, professional follow-up emails to a specific contact at a specific account.",
    "",
    "Your context is split into separate sections with different epistemic weight:",
    "- EPISODIC MEMORIES: what actually happened before (concrete events).",
    "- CONSOLIDATED OBSERVATIONS: beliefs the agent formed from repeated evidence. These are NOT unquestionable facts.",
    "- ACCOUNT MENTAL MODEL: the current summary of what the agent believes, including what remains uncertain.",
    "- UNCERTAINTIES/CONTRADICTIONS: contradictions and low-confidence beliefs — treat these as questions to resolve, not truths.",
    "",
    "Rules for using learned knowledge:",
    "- Evidence strength matters: a belief backed by many independent outcomes outweighs a single event.",
    "- A contradicted (contested) belief must NOT be blindly reused; acknowledge the conflict and adapt.",
    "- Recent evidence can supersede stale evidence.",
    "- NEVER invent customer or account facts that are not in the sections below.",
    "- When a belief influenced your draft, say so explicitly in observationUsage.",
    "- With no memory and no observations, produce a solid but generic draft.",
    "- Be concise: max 120 words in the body.",
    "",
    "Respond with strict JSON only, matching:",
    '{"subject": string, "body": string, "strategyLabels": string[],',
    ' "selectedStrategy": string,',
    ' "reasoningFactors": [{"source": "memory"|"observation"|"situation", "refId": string, "statement": string, "direction": "pushed toward"|"pushed against"|"uncertainty"}],',
    ' "confidence": number,  // 0..1, proportionate to the evidence you actually used',
    ' "expectedOutcome": string,',
    ' "memoryUsage": [{"memoryId": string, "relevance": string, "effect": string}],',
    ' "observationUsage": [{"observationId": string, "influence": string}]}',
    "selectedStrategy names your approach in one line. reasoningFactors lists ONLY the factors that actually shaped the decision, each referencing the memory id or observation id it came from (source \"situation\" needs no refId).",
    "In memoryUsage / observationUsage, list ONLY what you actually used and how it changed the draft. Empty arrays if none.",
  ].join("\n");

  const memorySection =
    memories.length === 0
      ? "(none — this is a first interaction with this account)"
      : memories
          .map((m) => {
            const when = m.occurredAt ? ` [${m.occurredAt.slice(0, 10)}]` : "";
            const tags = m.tags?.length ? ` #${m.tags.join(" #")}` : "";
            return `- (id=${m.id}${when}${tags}) ${m.text}`;
          })
          .join("\n");

  // Render observations and mental model as separate prompt blocks. Both the
  // mock LLM and live models parse by section header, so the full blocks must
  // be present — not just the first line of the combined render.
  const learningLines = renderLearningSections({ observations, mentalModel }).split("\n");
  const firstMmLine = learningLines.findIndex((l) => l.startsWith("Beliefs:"));
  const obsBlock = learningLines.slice(0, firstMmLine > 0 ? firstMmLine : learningLines.length).join("\n");
  const mmBlock = firstMmLine > 0 ? learningLines.slice(firstMmLine).join("\n") : "(none)";

  const uncertainties =
    mentalModel.uncertainties.length > 0
      ? mentalModel.uncertainties.map((u) => `- ${u}`).join("\n")
      : observations.some((o) => o.contradictingEvidence.length > 0)
        ? "- (see contested observations above)"
        : "(none recorded)";

  const user = [
    "CURRENT REQUEST:",
    `Account: ${account.company} (id: ${account.accountId})`,
    `Contact: ${account.contactName} (${account.contactRole})`,
    goal ? `Goal: ${goal}` : "Goal: follow up appropriately",
    `AE notes: ${account.situationNotes}`,
    "",
    "RELEVANT EPISODIC MEMORIES:",
    memorySection,
    "",
    "CONSOLIDATED OBSERVATIONS (beliefs formed from evidence — not facts):",
    obsBlock,
    "",
    "ACCOUNT MENTAL MODEL:",
    mentalModel.nativeContent ? mentalModel.nativeContent : mmBlock,
    "",
    "UNCERTAINTIES / CONTRADICTIONS:",
    uncertainties,
    "",
    "REQUIRED DECISION:",
    "Draft the follow-up email. Decide explicitly whether learned knowledge should change your approach this time, and report that in memoryUsage/observationUsage.",
  ].join("\n");

  return { system, user };
}

/**
 * Prompt for the retain step: what we write back into memory after an outcome.
 * We retain structured experience, not the whole conversation. The `runId`
 * metadata makes every retained memory traceable to the run that produced it.
 */
export function buildOutcomeMemory(plan: {
  account: AccountContext;
  draft: FollowUpDraft;
  outcome: string;
  feedback?: string;
  memoryUsage: MemoryUsage[];
  runId: string;
}): RetainedMemory[] {
  const { account, draft, outcome, feedback } = plan;
  const memories: RetainedMemory[] = [];

  // 1. Experience: what was tried and what happened (the core learning signal)
  memories.push({
    content:
      `Follow-up to ${account.contactName} (${account.contactRole}) at ${account.company}: ` +
      `sent "${draft.subject}". Outcome: ${outcome}.` +
      (feedback ? ` AE feedback: ${feedback}` : ""),
    context: "sales follow-up outcome",
    tags: ["outcome", "experience", account.accountId],
    metadata: {
      accountId: account.accountId,
      company: account.company,
      outcome,
      runId: plan.runId,
    },
  });

  // 2. Directive: turn AE feedback into a durable behavioral rule
  if (feedback) {
    memories.push({
      content: `For ${account.company}: ${feedback}`,
      context: "sales playbook correction",
      tags: ["directive", "playbook", account.accountId],
      metadata: { accountId: account.accountId, company: account.company, runId: plan.runId },
    });
  }

  return memories;
}

/** Sanitization guard used by the mock LLM path and tests. */
export function assertValidDraftPlan(plan: unknown): DraftPlan & {
  selectedStrategy?: string;
  reasoningFactors?: DecisionFactor[];
  confidence?: number;
  expectedOutcome?: string;
} {
  const p = plan as DraftPlan & {
    selectedStrategy?: string;
    reasoningFactors?: DecisionFactor[];
    confidence?: number;
    expectedOutcome?: string;
  };
  if (!p || typeof p !== "object") throw new Error("plan is not an object");
  if (typeof p.subject !== "string" || p.subject.length === 0)
    throw new Error("plan.subject missing");
  if (typeof p.body !== "string" || p.body.length === 0)
    throw new Error("plan.body missing");
  if (!Array.isArray(p.strategyLabels)) throw new Error("plan.strategyLabels missing");
  if (!Array.isArray(p.memoryUsage)) throw new Error("plan.memoryUsage missing");
  if (p.observationUsage !== undefined && !Array.isArray(p.observationUsage))
    throw new Error("plan.observationUsage must be an array");
  if (p.reasoningFactors !== undefined && !Array.isArray(p.reasoningFactors))
    throw new Error("plan.reasoningFactors must be an array");
  if (p.confidence !== undefined && (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1))
    throw new Error("plan.confidence must be a number in [0,1]");
  return p;
}
