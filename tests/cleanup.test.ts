import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pruneRuns } from "../src/runtime/cleanup.js";
import { registry } from "../src/runtime/registry.js";
import {
  eventsGzPath,
  eventsPath,
  messagesGzPath,
  runDir,
  writeMeta,
} from "../src/runtime/storage.js";
import { resetConfigCache } from "../src/config.js";
import type { RunMeta } from "../src/types.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed clock

async function setupHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-cleanup-"));
  process.env["CURSOR_HARNESS_HOME"] = root;
  resetConfigCache();
  // Reset registry singleton state.
  const anyReg = registry as unknown as { entries: Map<string, unknown>; loaded: boolean };
  anyReg.entries.clear();
  anyReg.loaded = false;
  return root;
}

async function teardownHome(root: string, originalHome: string | undefined): Promise<void> {
  if (originalHome === undefined) delete process.env["CURSOR_HARNESS_HOME"];
  else process.env["CURSOR_HARNESS_HOME"] = originalHome;
  resetConfigCache();
  await fs.rm(root, { recursive: true, force: true });
}

async function createRun(runId: string, opts: {
  status: RunMeta["status"];
  endedDaysAgo: number;
  eventsText?: string;
}): Promise<RunMeta> {
  const ended = NOW - opts.endedDaysAgo * DAY;
  const meta: RunMeta = {
    runId,
    status: opts.status,
    model: "auto",
    mode: "agent",
    permission: "auto",
    sandbox: "enabled",
    cwd: "/tmp",
    createdAt: ended - 1000,
    startedAt: ended - 1000,
    endedAt: ended,
    lastEventAt: ended,
    lastEventId: 3,
    turns: [],
    initialPrompt: "hi",
  };
  await fs.mkdir(runDir(runId), { recursive: true });
  await writeMeta(meta);
  await fs.writeFile(
    eventsPath(runId),
    opts.eventsText ??
      '{"eventId":1,"ts":1,"turnId":"t","raw":{"type":"assistant","message":{"content":[{"text":"final answer"}]}}}\n',
    "utf8",
  );
  const anyReg = registry as unknown as {
    entries: Map<string, { meta: RunMeta }>;
    loaded: boolean;
  };
  anyReg.entries.set(runId, { meta });
  anyReg.loaded = true;
  return meta;
}

describe("pruneRuns", () => {
  let root: string;
  const originalHome = process.env["CURSOR_HARNESS_HOME"];

  beforeEach(async () => {
    root = await setupHome();
  });
  afterEach(async () => {
    await teardownHome(root, originalHome);
  });

  it("leaves fresh terminal runs untouched", async () => {
    await createRun("fresh", { status: "completed", endedDaysAgo: 2 });
    const res = await pruneRuns({ now: NOW });
    expect(res.compressed).toEqual([]);
    expect(res.deleted).toEqual([]);
    await fs.access(eventsPath("fresh"));
  });

  it("compresses runs older than compressAfterDays and materializes summary", async () => {
    const meta = await createRun("aged", { status: "completed", endedDaysAgo: 10 });
    const res = await pruneRuns({ now: NOW });
    expect(res.compressed).toContain("aged");
    await expect(fs.access(eventsPath("aged"))).rejects.toBeDefined();
    await fs.access(eventsGzPath("aged"));
    const updated = registry.getMeta(meta.runId)!;
    expect(updated.retentionState).toBe("compressed");
    expect(updated.summary).toBe("final answer");
  });

  it("deletes runs older than maxAgeDays entirely", async () => {
    await createRun("ancient", { status: "completed", endedDaysAgo: 30 });
    const res = await pruneRuns({ now: NOW });
    expect(res.deleted).toContain("ancient");
    await expect(fs.access(runDir("ancient"))).rejects.toBeDefined();
    expect(registry.getMeta("ancient")).toBeUndefined();
  });

  it("skips non-terminal runs regardless of age", async () => {
    await createRun("stuck", { status: "running", endedDaysAgo: 30 });
    const res = await pruneRuns({ now: NOW });
    expect(res.compressed).not.toContain("stuck");
    expect(res.deleted).not.toContain("stuck");
    expect(res.skipped).toContain("stuck");
    await fs.access(runDir("stuck"));
  });

  it("enforces LRU cap on terminal survivors", async () => {
    for (let i = 0; i < 5; i++) {
      await createRun(`r${i}`, { status: "completed", endedDaysAgo: i });
    }
    const res = await pruneRuns({ now: NOW, keepLast: 2 });
    expect(res.deleted.sort()).toEqual(["r2", "r3", "r4"]);
    expect(registry.getMeta("r0")).toBeDefined();
    expect(registry.getMeta("r1")).toBeDefined();
    expect(registry.getMeta("r2")).toBeUndefined();
  });

  it("dry_run reports actions without touching disk or registry", async () => {
    await createRun("aged", { status: "completed", endedDaysAgo: 10 });
    await createRun("ancient", { status: "completed", endedDaysAgo: 30 });
    const res = await pruneRuns({ now: NOW, dryRun: true });
    expect(res.compressed).toContain("aged");
    expect(res.deleted).toContain("ancient");
    await fs.access(eventsPath("aged"));
    await fs.access(runDir("ancient"));
    await expect(fs.access(eventsGzPath("aged"))).rejects.toBeDefined();
  });

  it("readEvents transparently reads gzipped events after compression", async () => {
    await createRun("aged2", { status: "completed", endedDaysAgo: 10 });
    await pruneRuns({ now: NOW });
    const { readEvents } = await import("../src/runtime/storage.js");
    const events = await readEvents("aged2", 0, 100);
    expect(events).toHaveLength(1);
    expect(events[0]?.raw).toBeDefined();
    // messages.ndjson wasn't created in this test — gzip should no-op silently.
    await expect(fs.access(messagesGzPath("aged2"))).rejects.toBeDefined();
  });
});
