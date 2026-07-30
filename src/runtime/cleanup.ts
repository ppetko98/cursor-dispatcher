import type { RunMeta } from "../types.js";
import { loadConfig } from "../config.js";
import { registry } from "./registry.js";
import {
  deleteRunDir,
  eventsPath,
  gzipFileInPlace,
  messagesPath,
  readEvents,
} from "./storage.js";
import { summarize } from "./events.js";

export interface PruneOptions {
  compressAfterDays?: number;
  maxAgeDays?: number;
  keepLast?: number;
  dryRun?: boolean;
  now?: number; // injectable clock for tests
}

export interface PruneResult {
  compressed: string[];
  deleted: string[];
  skipped: string[];
  dryRun: boolean;
  compressAfterDays: number;
  maxAgeDays: number;
  keepLast: number;
}

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

function ageDays(meta: RunMeta, now: number): number {
  const t = meta.endedAt ?? meta.lastEventAt ?? meta.startedAt;
  return (now - t) / (24 * 60 * 60 * 1000);
}

export async function pruneRuns(opts: PruneOptions = {}): Promise<PruneResult> {
  const cfg = await loadConfig();
  const compressAfterDays = opts.compressAfterDays ?? cfg.retention.compressAfterDays;
  const maxAgeDays = opts.maxAgeDays ?? cfg.retention.maxAgeDays;
  const keepLast = opts.keepLast ?? cfg.retention.maxRuns;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? Date.now();

  const compressed: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];

  // Snapshot to avoid mutation-during-iteration.
  const all = registry.list();

  // Pass 1: age-based delete + compress. Non-terminal runs are always skipped.
  for (const meta of all) {
    if (!TERMINAL.has(meta.status)) {
      skipped.push(meta.runId);
      continue;
    }
    const age = ageDays(meta, now);
    if (age >= maxAgeDays) {
      if (!dryRun) {
        await deleteRunDir(meta.runId);
        registry.forget(meta.runId);
      }
      deleted.push(meta.runId);
    } else if (age >= compressAfterDays && meta.retentionState !== "compressed") {
      if (!dryRun) {
        await compressRun(meta);
      }
      compressed.push(meta.runId);
    }
  }

  // Pass 2: LRU cap on surviving terminal runs. Oldest (by endedAt) drop first.
  const survivors = registry
    .list()
    .filter((m) => TERMINAL.has(m.status))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const overflow = survivors.slice(keepLast);
  for (const meta of overflow) {
    if (deleted.includes(meta.runId)) continue;
    if (!dryRun) {
      await deleteRunDir(meta.runId);
      registry.forget(meta.runId);
    }
    deleted.push(meta.runId);
  }

  return {
    compressed,
    deleted,
    skipped,
    dryRun,
    compressAfterDays,
    maxAgeDays,
    keepLast,
  };
}

async function compressRun(meta: RunMeta): Promise<void> {
  // Materialize the summary before we lose the raw events.
  if (!meta.summary) {
    const events = await readEvents(meta.runId, 0, 100_000);
    meta.summary = summarize(events);
  }
  await gzipFileInPlace(eventsPath(meta.runId));
  await gzipFileInPlace(messagesPath(meta.runId));
  meta.retentionState = "compressed";
  meta.compressedAt = Date.now();
  await registry.updateMeta(meta);
}
