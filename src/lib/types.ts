/**
 * Shared domain types for the learning loop.
 *
 * The architecture distinguishes, explicitly:
 *   1. current input    (DraftRequest)
 *   2. retrieved memory (RecalledMemory)
 *   3. agent reasoning  (memoryUsage[] + rationale inside DraftRun)
 *   4. agent output     (FollowUpDraft)
 *   5. outcome/feedback (OutcomeReport)
 *   6. new memory       (RetainedMemory, written back via retain)
 */

export interface AccountContext {
  /** Stable account identifier */
  accountId: string;
  /** Company being sold into */
  company: string;
  /** Who we are talking to */
  contactName: string;
  contactRole: string;
  /** Free-text situation notes from the AE (current input, not memory) */
  situationNotes: string;
}

/** One retrieved memory shown to the reasoning step. */
export interface RecalledMemory {
  id: string;
  text: string;
  /** Hindsight fact type: world | experience | observation … */
  type?: string | null;
  /** ISO timestamp when this was relevant/occurred, if provided */
  occurredAt?: string | null;
  tags?: string[];
  metadata?: Record<string, string>;
}

/** Trace of how a specific memory influenced the output. */
export interface MemoryUsage {
  memoryId: string;
  /** Short machine-generated reason this memory was included */
  relevance: string;
  /** Concrete effect on the draft (e.g. "avoided pricing topic", "used champion name") */
  effect: string;
}

export interface FollowUpDraft {
  subject: string;
  body: string;
  /** Tactics the agent chose for this draft */
  strategyLabels: string[];
}

/** Raw structured output of the reasoning step, before wrapping into a run. */
export interface DraftPlan {
  subject: string;
  body: string;
  strategyLabels: string[];
  memoryUsage: MemoryUsage[];
  /** How learned observations influenced the plan (optional from live LLMs). */
  observationUsage?: ObservationUsage[];
}

export interface DraftRequest {
  account: AccountContext;
  /** Optional explicit ask, e.g. "re-engage after silence" */
  goal?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The business decision object (audit-first representation of one decision)
//
// An AgentDecision is the structured, inspectable form of "what did the agent
// decide and why?" — populated by the orchestrator from actual state: recalled
// memories, active beliefs, and the reasoning output. It exists so the UI and
// audit trail can present the full causal chain:
//   situation → recalled experience → influence → decision → outcome → learning
// ─────────────────────────────────────────────────────────────────────────────

/** Structured reasoning factor: why a piece of knowledge shaped the decision. */
export interface DecisionFactor {
  /** Which knowledge source produced this factor. */
  source: "memory" | "observation" | "situation";
  /** Reference id when source is memory/observation ("situation" needs none). */
  refId?: string;
  /** Human-readable statement of the factor. */
  statement: string;
  /** How it pushed the decision ("pushed toward" / "pushed against" / "uncertainty"). */
  direction: "pushed toward" | "pushed against" | "uncertainty";
  /** Evidence weight behind the factor (observation confidence, memory count). */
  weight?: number;
}

/** The complete, auditable business decision made for one request. */
export interface AgentDecision {
  /** Compact restatement of the situation the agent is handling. */
  situation: string;
  /** What the agent is trying to accomplish. */
  objective: string;
  /** Constraints acknowledged (e.g. beliefs that limit the action space). */
  constraints: string[];
  /** Active beliefs consulted (observation ids). */
  beliefsConsulted: string[];
  /** Open questions carried into the decision (from mental-model uncertainties). */
  uncertainties: string[];
  /** Why this strategy, in structured factor form. */
  reasoningFactors: DecisionFactor[];
  /** The chosen strategy (one-line, human-readable). */
  selectedStrategy: string;
  /** The action taken: the draft itself. */
  action: FollowUpDraft;
  /** 0..1 — derived from evidence strength, never asserted by fiat. */
  confidence: number;
  /** What the agent expected to happen, from the chosen action. */
  expectedOutcome: string;
}

/** Provenance: was a memory real Hindsight data or local mock? */
export type MemorySource = "hindsight" | "local";

export interface DraftRun {
  runId: string;
  createdAt: string;
  request: DraftRequest;
  /** Stage 2: exactly what recall returned */
  recalledMemories: RecalledMemory[];
  memorySource: MemorySource;
  recallQuery: string;
  /** Stage 3: how each memory changed the decision (audit trail) */
  memoryUsage: MemoryUsage[];
  /** Stage 4: the produced action */
  draft: FollowUpDraft;
  llmMode: "live" | "mock";
  /** Populated later when the outcome is reported */
  outcome?: OutcomeReport;
  /** Memories retained because of this run (stage 6) */
  retainedMemoryIds: string[];
  /** Learning layer: knowledge held BEFORE acting + delta learned AFTER outcome. */
  learning?: DraftRunLearning;
  /** The complete business decision (stages 1–5) with full provenance. */
  decision?: AgentDecision;
  /** Stage 9: human-readable before/after of the mental model, after outcome. */
  beforeAfter?: {
    before: string[];
    after: string[];
  };
}

export interface HealthStatus {
  ok: boolean;
  /** Provider actually in use (local-file or hindsight-cloud). */
  memoryMode: "hindsight-cloud" | "local-file";
  llmMode: "live" | "mock";
  /** True only when connectivity to the memory backend has been VERIFIED this request. */
  hindsightReachable?: boolean;
  hindsightVersion?: string;
  /** Whether Hindsight Cloud credentials are present in the environment (NOT proof of connectivity). */
  hindsightConfigured?: boolean;
  /** True when running on the local fallback rather than real Hindsight. */
  localFallback?: boolean;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning layer: episodic memory → observations → account mental model
//
// Hindsight context: the installed client exposes mental-model CRUD and
// observation-TYPED recall results, but no client API to create/list
// observation OBJECTS directly. Application-level consolidation (below) is
// grounded in evidence retained INTO Hindsight; when the backend is Hindsight
// Cloud, its native observation consolidation runs server-side in parallel.
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome valence, used to orient evidence and pattern detection. */
export type OutcomeValence = "positive" | "negative" | "neutral";

/** Map an outcome result to its valence for evidence/learning purposes. */
export function outcomeValence(outcome: OutcomeResult): OutcomeValence {
  switch (outcome) {
    case "replied":
    case "meeting_booked":
      return "positive";
    case "no_reply":
      return "negative";
    case "bounced":
      return "negative";
  }
}

/** One piece of evidence linking an observation back to a concrete experience. */
export interface MemoryEvidence {
  /** Run whose outcome produced this evidence. */
  runId: string;
  /** Retained episodic memory id, where available. */
  memoryId?: string;
  /** What happened, as retained. */
  summary: string;
  /** Outcome result that occurred. */
  outcome: OutcomeResult;
  valence: OutcomeValence;
  /** AE feedback attached to the outcome, if any. */
  feedback?: string;
  /** When the outcome was reported. */
  occurredAt: string;
  /** Account the evidence belongs to (isolation + audit). */
  accountId: string;
  /** Approach labels used on the draft that produced this outcome. */
  strategyLabels: string[];
}

export type ObservationStatus = "active" | "contested" | "retired";

/**
 * A consolidated belief about an account, supported by evidence.
 * application-level type (Hindsight consolidates observations server-side;
 * its client API does not expose observation objects directly).
 */
export interface Observation {
  id: string;
  accountId: string;
  /** The learned belief, stated so an agent can act on it. */
  statement: string;
  /** 0..1 — evidence-weighted confidence, never set by fiat. */
  confidence: number;
  supportingEvidence: MemoryEvidence[];
  contradictingEvidence: MemoryEvidence[];
  createdAt: string;
  updatedAt: string;
  status: ObservationStatus;
  /** Ids of the episodic memories that seeded this observation. */
  sourceMemoryIds: string[];
  /** Stable pattern key this observation consolidates (deterministic grouping). */
  patternKey: string;
  tags: string[];
}

/**
 * Account-level understanding available to the agent BEFORE reasoning.
 * Application-level summary; with Hindsight Cloud the bank also carries a
 * native mental model of the same question, refreshed by the server.
 */
export interface AccountMentalModel {
  accountId: string;
  generatedAt: string;
  /** Concise beliefs with their evidence weight. */
  beliefs: Array<{ statement: string; confidence: number; evidenceCount: number }>;
  /** Open questions the agent should probe, not assume. */
  uncertainties: string[];
  /** Approaches evidence says worked. */
  approachesToRepeat: string[];
  /** Approaches evidence says failed or should be handled differently. */
  approachesToAvoid: string[];
  /** Observation ids feeding this model. */
  observationIds: string[];
  /** Provider-native model content passed through verbatim (Hindsight only). */
  nativeContent?: string;
}

/** A learning consolidation event, recorded for the audit trail / UI delta. */
export interface LearningDelta {
  /** Observations created by this outcome. */
  observationsCreated: Observation[];
  /** Observations strengthened/weakened/contested by this outcome. */
  observationsUpdated: Array<{
    observationId: string;
    before: { confidence: number; status: ObservationStatus };
    beforeConfidence: number;
    afterConfidence: number;
    afterStatus: ObservationStatus;
  }>;
  /** What the mental model adds next time, as a human-readable line. */
  mentalModelNote: string;
  consolidatedAt: string;
}

/** Evidence item attached when the reasoning used a learned observation. */
export interface ObservationUsage {
  observationId: string;
  statement: string;
  confidence: number;
  /** How the belief influenced the decision, e.g. "avoided pricing-led CTA". */
  influence: string;
}

/** Extend DraftRun so the audit trail shows knowledge before + learning after. */
export interface DraftRunLearning {
  /** Observations the agent considered BEFORE acting. */
  observationsConsidered: ObservationUsage[];
  /** Snapshot of the account mental model at decision time. */
  mentalModelSnapshot?: {
    generatedAt: string;
    beliefs: Array<{ statement: string; confidence: number; evidenceCount: number }>;
    uncertainties: string[];
    approachesToRepeat: string[];
    approachesToAvoid: string[];
  };
  /** Populated after outcome consolidation: what changed because of this outcome. */
  learningDelta?: LearningDelta;
}

export type OutcomeResult = "replied" | "no_reply" | "bounced" | "meeting_booked";

export interface OutcomeReport {
  outcome: OutcomeResult;
  /** AE's free-text correction, e.g. "pricing too aggressive for this stage" */
  feedback?: string;
  reportedAt: string;
}

/** A memory written back into Hindsight (stage 6). */
export interface RetainedMemory {
  content: string;
  context: string;
  tags: string[];
  metadata: Record<string, string>;
}
