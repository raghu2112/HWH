import { promises as fs } from "node:fs";
import path from "node:path";
import type { Observation } from "../types";
import { getEnv } from "../config/env";

/**
 * Evidence ledger for consolidated observations.
 *
 * This is deliberately separate from the RunStore: runs are the audit trail of
 * decisions; observations are the agent's consolidated BELIEFS. Keeping them
 * apart means the UI can show "what the agent knew then" vs "what it believes
 * now" without conflating decision history with learned knowledge.
 *
 * With Hindsight Cloud, the bank's native observations/mental models carry the
 * same content server-side; this ledger is the deterministic, key-free
 * equivalent that keeps the app honest about what is provider-native vs local.
 */
export class ObservationStore {
  private file: string;

  constructor(opts?: { dataDir?: string }) {
    this.file = path.join(opts?.dataDir ?? getEnv().dataDir, "observations.json");
  }

  private async readAll(): Promise<Observation[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      return JSON.parse(raw) as Observation[];
    } catch {
      return [];
    }
  }

  private async writeAll(observations: Observation[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(observations, null, 2), "utf8");
  }

  /** All observations for one account (strict isolation). */
  async listByAccount(accountId: string): Promise<Observation[]> {
    return (await this.readAll()).filter((o) => o.accountId === accountId);
  }

  /** Upsert a full set of observations for the patterns touched in one consolidation. */
  async upsertMany(observations: Observation[]): Promise<void> {
    const all = await this.readAll();
    for (const obs of observations) {
      const idx = all.findIndex((o) => o.id === obs.id || o.patternKey === obs.patternKey);
      if (idx >= 0) all[idx] = obs;
      else all.push(obs);
    }
    await this.writeAll(all);
  }

  async reset(): Promise<void> {
    await this.writeAll([]);
  }
}

let cached: ObservationStore | undefined;
export function getObservationStore(): ObservationStore {
  if (!cached) cached = new ObservationStore();
  return cached;
}
export function resetObservationStore(): void {
  cached = undefined;
}
