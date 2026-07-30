import type { RunMeta, RunStatus } from "../types.js";
import { listRunIds, readMeta, writeMeta, ensureRunDir } from "./storage.js";
import type { CursorRunner } from "./runner.js";
import { loadConfig } from "../config.js";

interface RegistryEntry {
  meta: RunMeta;
  runner?: CursorRunner;
}

class Registry {
  private entries = new Map<string, RegistryEntry>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    const ids = await listRunIds();
    for (const id of ids) {
      const meta = await readMeta(id);
      if (!meta) continue;
      // Backfill fields added in later versions so older on-disk runs still load.
      if (!meta.permission) meta.permission = "auto";
      // Runs that were running when we shut down are now orphaned.
      if (meta.status === "running" || meta.status === "created") {
        meta.status = "failed";
        meta.endedAt = Date.now();
        await writeMeta(meta);
      }
      this.entries.set(id, { meta });
    }
    this.loaded = true;

    const cfg = await loadConfig();
    if (cfg.retention.pruneOnStartup) {
      // Lazy import avoids a cleanup <-> registry cycle at module init.
      const { pruneRuns } = await import("./cleanup.js");
      await pruneRuns().catch(() => {});
    }
  }

  async create(meta: RunMeta, runner: CursorRunner): Promise<void> {
    await ensureRunDir(meta.runId);
    await writeMeta(meta);
    this.entries.set(meta.runId, { meta, runner });
  }

  attachRunner(runId: string, runner: CursorRunner): void {
    const e = this.entries.get(runId);
    if (e) e.runner = runner;
  }

  get(runId: string): RegistryEntry | undefined {
    return this.entries.get(runId);
  }

  getMeta(runId: string): RunMeta | undefined {
    return this.entries.get(runId)?.meta;
  }

  list(filter?: { status?: RunStatus; since?: number }): RunMeta[] {
    const all = [...this.entries.values()].map((e) => e.meta);
    return all
      .filter((m) => (filter?.status ? m.status === filter.status : true))
      .filter((m) => (filter?.since ? m.startedAt >= filter.since : true))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async updateMeta(meta: RunMeta): Promise<void> {
    const entry = this.entries.get(meta.runId);
    if (entry) entry.meta = meta;
    await writeMeta(meta);
  }

  forget(runId: string): void {
    this.entries.delete(runId);
  }
}

export const registry = new Registry();
