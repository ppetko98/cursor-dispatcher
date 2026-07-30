import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "../plugin/hooks/on-user-prompt.mjs");

interface HookResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runHook(home: string, sessionId: string): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CURSOR_HARNESS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.on("error", reject);
    child.stdin.end(JSON.stringify({ session_id: sessionId }));
  });
}

async function writeRun(
  home: string,
  runId: string,
  status: string,
  spawnedBySession: string | undefined,
  summary?: string,
): Promise<void> {
  const runDir = path.join(home, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  const meta: Record<string, unknown> = {
    runId,
    status,
    model: "auto",
    mode: "agent",
    permission: "auto",
    sandbox: "enabled",
    cwd: "/tmp",
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    lastEventId: 3,
    turns: [],
    initialPrompt: "",
  };
  if (spawnedBySession) meta["spawnedBySession"] = spawnedBySession;
  if (summary) meta["summary"] = summary;
  await fs.writeFile(path.join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
}

describe("on-user-prompt hook", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "harness-hook-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("emits this session's own runs cleanly and marks mismatched-session runs as [unlinked]", async () => {
    await writeRun(home, "mine-done", "completed", "sess-A", "Wrote greet.py");
    await writeRun(home, "theirs-done", "completed", "sess-B", "did other stuff");
    await writeRun(home, "mine-running", "running", "sess-A");

    const first = await runHook(home, "sess-A");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("mine-done");
    expect(first.stdout).toContain("Wrote greet.py");
    // mismatched session still surfaces, but tagged
    expect(first.stdout).toContain("theirs-done");
    expect(first.stdout).toContain("[unlinked]");
    // own-session runs are NOT tagged
    expect(first.stdout).not.toMatch(/\[unlinked\] SUBAGENT mine-done/);
    // in-flight runs never appear
    expect(first.stdout).not.toContain("mine-running");

    // A second invocation should NOT re-report the same runs.
    const second = await runHook(home, "sess-A");
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("");
  });

  it("reports newly-transitioned runs on subsequent invocations", async () => {
    await writeRun(home, "r1", "completed", "sess-X", "first");
    const first = await runHook(home, "sess-X");
    expect(first.stdout).toContain("r1");

    await writeRun(home, "r2", "failed", "sess-X", "boom");
    const second = await runHook(home, "sess-X");
    expect(second.stdout).toContain("r2");
    expect(second.stdout).not.toContain("r1");
  });

  it("falls back to reporting unscoped runs when no session id passed by Claude Code", async () => {
    await writeRun(home, "legacy", "completed", undefined, "old run");
    // Simulate a session id present; unscoped run should still get reported
    // since spawnedBySession is absent.
    const res = await runHook(home, "sess-Z");
    expect(res.stdout).toContain("legacy");
  });

  it("exits cleanly (0) even when the runs dir is missing", async () => {
    const res = await runHook(home, "sess-fresh");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
  });
});
