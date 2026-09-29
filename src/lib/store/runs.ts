import { promises as fs } from "node:fs";
import path from "node:path";
import type { DraftRun, OutcomeReport, OutcomeResult } from "../types";
import { getEnv } from "../config/env";

/**
 * File-backed persistence for the learning-loop audit trail: every run, every
 * outcome, every retention. This is what makes the demo inspectable — and it is
 * deliberately NOT the agent's memory (that's Hindsight). This store answers
 * "what happened across interactions?"; Hindsight answers "what did the agent
 * learn and remember?"
 */
export type StoredRun = DraftRun;

export class RunStore {
  private file: string;

  constructor(opts?: { dataDir?: string }) {
    this.file = path.join(opts?.dataDir ?? getEnv().dataDir, "runs.json");
  }

  private async readAll(): Promise<StoredRun[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      return JSON.parse(raw) as StoredRun[];
    } catch {
      return [];
    }
  }

  private async writeAll(runs: StoredRun[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(runs, null, 2), "utf8");
  }

  async save(run: DraftRun): Promise<void> {
    const runs = await this.readAll();
    const idx = runs.findIndex((r) => r.runId === run.runId);
    if (idx >= 0) runs[idx] = run;
    else runs.push(run);
    await this.writeAll(runs);
  }

  async get(runId: string): Promise<StoredRun | undefined> {
    return (await this.readAll()).find((r) => r.runId === runId);
  }

  async list(accountId?: string): Promise<StoredRun[]> {
    const runs = await this.readAll();
    const filtered = accountId ? runs.filter((r) => r.request.account.accountId === accountId) : runs;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async attachOutcome(runId: string, outcome: OutcomeReport): Promise<StoredRun | undefined> {
    const runs = await this.readAll();
    const run = runs.find((r) => r.runId === runId);
    if (!run) return undefined;
    run.outcome = outcome;
    await this.writeAll(runs);
    return run;
  }

  /** Demo metric: how many runs carry an outcome (learning signal volume). */
  async stats(): Promise<{ runs: number; withOutcome: number; byResult: Record<OutcomeResult, number> }> {
    const runs = await this.readAll();
    const byResult: Record<OutcomeResult, number> = {
      replied: 0,
      no_reply: 0,
      bounced: 0,
      meeting_booked: 0,
    };
    for (const r of runs) {
      if (r.outcome) byResult[r.outcome.outcome] += 1;
    }
    return { runs: runs.length, withOutcome: runs.filter((r) => r.outcome).length, byResult };
  }
}

let cached: RunStore | undefined;
export function getRunStore(): RunStore {
  if (!cached) cached = new RunStore();
  return cached;
}
export function resetRunStore(): void {
  cached = undefined;
}
