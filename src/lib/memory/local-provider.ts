import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AccountMentalModel,
  MemorySource,
  Observation,
  RecalledMemory,
  RetainedMemory,
} from "../types";
import type { DraftRequest } from "../types";
import { recallQueryFor, rankObservations, type MemoryProvider } from "./provider";
import { buildMentalModel } from "./consolidator";
import { getEnv } from "../config/env";

/**
 * Local file-backed memory provider. Honors the same contract as
 * HindsightProvider — including the learning layer — so the whole two-loop
 * system is demoable and testable with zero keys and zero network.
 *
 * Observations live in an application-level ledger (observations.json). This
 * is the deterministic equivalent of Hindsight's server-side consolidation,
 * NOT a claim that Hindsight works that way client-side.
 */
interface StoredMemory extends RetainedMemory {
  id: string;
  storedAt: string;
}

export class LocalMemoryProvider implements MemoryProvider {
  readonly source: MemorySource = "local";
  private file: string;
  private observationsFile: string;
  private cache: StoredMemory[] | null = null;

  constructor(opts?: { dataDir?: string }) {
    const dataDir = opts?.dataDir ?? getEnv().dataDir;
    this.file = path.join(dataDir, "memories.json");
    this.observationsFile = path.join(dataDir, "observations.json");
  }

  private async load(): Promise<StoredMemory[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.cache = JSON.parse(raw) as StoredMemory[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async persist(items: StoredMemory[]): Promise<void> {
    this.cache = items;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(items, null, 2), "utf8");
  }

  /**
   * Demo-reset support: the reset endpoint deletes the backing files, so the
   * in-memory cache MUST be dropped too — otherwise recall keeps serving the
   * old memories and the next persist() would write them back to disk.
   */
  clearInMemoryCache(): void {
    this.cache = null;
  }

  async retain(memories: RetainedMemory[]): Promise<string[]> {
    const items = await this.load();
    const ids: string[] = [];
    for (const m of memories) {
      const id = `local_${crypto.randomUUID()}`;
      items.push({ ...m, id, storedAt: new Date().toISOString() });
      ids.push(id);
    }
    await this.persist(items);
    return ids;
  }

  async recall(request: DraftRequest, limit = 8): Promise<RecalledMemory[]> {
    const items = await this.load();

    // Per-account isolation: memories are tagged with the accountId at retain
    // time; recall only sees memories belonging to the requesting account.
    const accountTag = request.account.accountId;
    const scoped =
      accountTag && accountTag !== "unassigned"
        ? items.filter(
            (m) =>
              (m.tags ?? []).includes(accountTag) ||
              m.metadata?.accountId === accountTag
          )
        : items;

    const queryTerms = recallQueryFor(request)
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scored = scoped.map((m) => {
      const haystack = [m.content, m.context, ...(m.tags ?? [])]
        .join(" ")
        .toLowerCase();
      const overlap = queryTerms.filter((t) => haystack.includes(t)).length;
      const ageDays =
        (Date.now() - new Date(m.storedAt).getTime()) / (1000 * 60 * 60 * 24);
      const recency = 1 / (1 + ageDays);
      // Relevance = keyword overlap + recency ONLY. Account membership is not
      // a relevance signal — the scoping filter above already guarantees it.
      // Scoring it here pushed EVERY account memory over the "no relevant hit"
      // floor below, so merely-retained-but-unrelated memories reached the
      // decision (found by the adversarial scenario-E audit).
      return { m, score: overlap * 2 + recency };
    });

    // Threshold rationale: a fresh memory with ZERO keyword overlap scores ~1.0
    // (recency alone), so anything below 1.2 is effectively "no relevant hit".
    // Any single real keyword hit scores >= 2. This keeps cross-account noise out.
    return scored
      .filter((s) => s.score >= 1.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ m }) => ({
        id: m.id,
        text: m.content,
        type: "world",
        occurredAt: m.storedAt,
        tags: m.tags ?? [],
        metadata: m.metadata ?? {},
      }));
  }

  // ── Learning layer ────────────────────────────────────────────────────────

  private async readObservations(): Promise<Observation[]> {
    try {
      const raw = await fs.readFile(this.observationsFile, "utf8");
      return JSON.parse(raw) as Observation[];
    } catch {
      return [];
    }
  }

  private async writeObservations(observations: Observation[]): Promise<void> {
    await fs.mkdir(path.dirname(this.observationsFile), { recursive: true });
    await fs.writeFile(this.observationsFile, JSON.stringify(observations, null, 2), "utf8");
  }

  async recallObservations(request: DraftRequest): Promise<Observation[]> {
    const accountId = request.account.accountId;
    const all = await this.readObservations();
    // Strict isolation by construction: the ledger is partitioned by accountId.
    return rankObservations(all.filter((o) => o.accountId === accountId));
  }

  async listObservations(accountId: string): Promise<Observation[]> {
    return (await this.readObservations()).filter((o) => o.accountId === accountId);
  }

  async saveObservations(observations: Observation[]): Promise<void> {
    const all = await this.readObservations();
    for (const obs of observations) {
      const idx = all.findIndex((o) => o.id === obs.id || o.patternKey === obs.patternKey);
      if (idx >= 0) all[idx] = obs;
      else all.push(obs);
    }
    await this.writeObservations(all);
  }

  async getAccountMentalModel(accountId: string): Promise<{ model: AccountMentalModel; native: boolean }> {
    const all = await this.readObservations();
    const own = all.filter((o) => o.accountId === accountId);
    return { model: buildMentalModel(accountId, own), native: false };
  }

  async health(): Promise<{ ok: boolean; source: MemorySource; version?: string }> {
    await this.load();
    return { ok: true, source: this.source, version: "local-1.0" };
  }
}
