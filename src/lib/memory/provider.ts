import type {
  AccountMentalModel,
  DraftRequest,
  MemorySource,
  Observation,
  RecalledMemory,
  RetainedMemory,
} from "../types";

/**
 * MemoryProvider — the Hindsight-first abstraction.
 *
 * Real implementation: HindsightProvider (Hindsight Cloud / self-hosted).
 * Fallback: LocalMemoryProvider (file-backed, same semantics for the demo).
 *
 * The learning loop only ever talks to this interface, so swapping providers
 * never touches agent code. The orchestrator must not bypass this abstraction
 * to reach Hindsight directly.
 */
export interface MemoryProvider {
  /** Which backing store this provider implements (provenance shown in the UI). */
  readonly source: MemorySource;
  /** Write new memories (stage 6 of the loop). */
  retain(memories: RetainedMemory[]): Promise<string[]>;
  /** Retrieve relevant memories for the current input (stage 2). */
  recall(request: DraftRequest, limit?: number): Promise<RecalledMemory[]>;
  /** Probe whether the backing memory system is reachable/configured. */
  health(): Promise<{ ok: boolean; source: MemorySource; version?: string }>;

  // ── Learning layer (second learning loop on top of episodic memory) ──

  /**
   * Recall consolidated observations relevant to the request. Provider-native
   * when the backend supports observation-typed recall (Hindsight does);
   * otherwise the provider serves its own application-level ledger (local).
   */
  recallObservations(request: DraftRequest): Promise<Observation[]>;

  /** All observations for an account (consolidation input; not ranked). */
  listObservations(accountId: string): Promise<Observation[]>;

  /**
   * Persist consolidated observations. Implementations decide whether this is
   * provider-native or an application-level ledger; callers never care.
   */
  saveObservations(observations: Observation[]): Promise<void>;

  /**
   * Account mental model: "what should I already know before acting for this
   * account?" Hindsight-native when a bank mental model exists (the SDK
   * exposes full CRUD); local builds a deterministic summary from the
   * observation ledger. `native` tells the UI which one the agent used.
   */
  getAccountMentalModel(accountId: string): Promise<{ model: AccountMentalModel; native: boolean }>;
}

/** Default observation ranking shared by providers: status, then confidence. */
export function rankObservations(observations: Observation[], limit = 5): Observation[] {
  const weight = { active: 2, contested: 1, retired: 0 } as const;
  return [...observations]
    .filter((o) => o.status !== "retired")
    .sort(
      (a, b) =>
        weight[b.status] - weight[a.status] ||
        b.confidence - a.confidence ||
        b.updatedAt.localeCompare(a.updatedAt)
    )
    .slice(0, limit);
}

export function recallQueryFor(request: DraftRequest): string {
  const { account, goal } = request;
  const parts = [
    account.company,
    account.contactName,
    account.contactRole,
    goal,
    account.situationNotes,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(" ");
}
