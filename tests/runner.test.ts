import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { CursorRunner, createRunMeta } from "../src/runtime/runner.js";
import { registry } from "../src/runtime/registry.js";
import { readEvents } from "../src/runtime/storage.js";
import { resetConfigCache } from "../src/config.js";

const FAKE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-cursor-agent.mjs",
);

async function withHarnessHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-runner-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const originals = {
    home: process.env["CURSOR_HARNESS_HOME"],
    bin: process.env["CURSOR_HARNESS_BIN"],
    cwd: process.env["CURSOR_HARNESS_CWD_ROOT"],
  };
  process.env["CURSOR_HARNESS_HOME"] = root;
  process.env["CURSOR_HARNESS_BIN"] = FAKE_SCRIPT;
  process.env["CURSOR_HARNESS_CWD_ROOT"] = workspace;
  resetConfigCache();
  try {
    return await fn(root);
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      const key =
        k === "home" ? "CURSOR_HARNESS_HOME" : k === "bin" ? "CURSOR_HARNESS_BIN" : "CURSOR_HARNESS_CWD_ROOT";
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    resetConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("CursorRunner (with fake cursor-agent)", () => {
  beforeEach(async () => {
    await fs.chmod(FAKE_SCRIPT, 0o755).catch(() => {});
  });

  it("streams NDJSON, captures chat_id, and marks completed on exit", async () => {
    await withHarnessHome(async () => {
      const workspace = process.env["CURSOR_HARNESS_CWD_ROOT"]!;
      const meta = await createRunMeta({
        runId: "run-1",
        model: "gpt-5",
        mode: "ask",
        permission: "read",
        sandbox: "enabled",
        cwd: workspace,
        initialPrompt: "hi",
      });
      const runner = new CursorRunner(meta.runId);
      await registry.create(meta, runner);
      await runner.startTurn({ message: "hi", kind: "spawn" });
      await runner.waitIdle();

      const updated = registry.getMeta("run-1")!;
      expect(updated.status).toBe("completed");
      expect(updated.chatId).toBe("chat-xyz");

      const events = await readEvents("run-1", 0, 100);
      const types = events.map((e) => e.type);
      expect(types).toContain("start");
      expect(types).toContain("assistant");
      expect(types).toContain("end");
    });
  });

  it("maps permission=read to --mode ask and omits --trust/--yolo/--auto-review", async () => {
    await withHarnessHome(async () => {
      const workspace = process.env["CURSOR_HARNESS_CWD_ROOT"]!;
      const meta = await createRunMeta({
        runId: "run-perm-read",
        model: "auto",
        mode: "agent",
        permission: "read",
        sandbox: "enabled",
        cwd: workspace,
        initialPrompt: "hi",
      });
      const runner = new CursorRunner(meta.runId);
      await registry.create(meta, runner);
      await runner.startTurn({ message: "hi", kind: "spawn" });
      await runner.waitIdle();
      const events = await readEvents("run-perm-read", 0, 100);
      const startEv = events.find((e) => e.type === "start");
      const argv = ((startEv?.raw as { argv?: string[] }) ?? {}).argv ?? [];
      expect(argv).toContain("--mode");
      const modeIdx = argv.indexOf("--mode");
      expect(argv[modeIdx + 1]).toBe("ask");
      expect(argv).not.toContain("--trust");
      expect(argv).not.toContain("--yolo");
      expect(argv).not.toContain("--auto-review");
    });
  });

  it("maps permission=trust to --trust --yolo", async () => {
    await withHarnessHome(async () => {
      const workspace = process.env["CURSOR_HARNESS_CWD_ROOT"]!;
      const meta = await createRunMeta({
        runId: "run-perm-trust",
        model: "auto",
        mode: "agent",
        permission: "trust",
        sandbox: "enabled",
        cwd: workspace,
        initialPrompt: "hi",
      });
      const runner = new CursorRunner(meta.runId);
      await registry.create(meta, runner);
      await runner.startTurn({ message: "hi", kind: "spawn" });
      await runner.waitIdle();
      const events = await readEvents("run-perm-trust", 0, 100);
      const startEv = events.find((e) => e.type === "start");
      const argv = ((startEv?.raw as { argv?: string[] }) ?? {}).argv ?? [];
      expect(argv).toContain("--trust");
      expect(argv).toContain("--yolo");
      expect(argv).not.toContain("--auto-review");
    });
  });

  it("cancels an in-flight turn", async () => {
    await withHarnessHome(async () => {
      const workspace = process.env["CURSOR_HARNESS_CWD_ROOT"]!;
      const meta = await createRunMeta({
        runId: "run-2",
        model: "gpt-5",
        mode: "ask",
        permission: "read",
        sandbox: "enabled",
        cwd: workspace,
        initialPrompt: "slow please",
      });
      const runner = new CursorRunner(meta.runId);
      await registry.create(meta, runner);
      await runner.startTurn({ message: "slow please", kind: "spawn" });
      // Give the child a beat to start.
      await new Promise((r) => setTimeout(r, 50));
      await runner.cancel();

      const updated = registry.getMeta("run-2")!;
      expect(["cancelled", "failed"]).toContain(updated.status);
    });
  });
});
