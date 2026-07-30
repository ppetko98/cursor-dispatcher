import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { RunMeta, TurnRecord } from "../types.js";
import {
  eventsPath,
  runDir,
  writeMeta,
} from "./storage.js";
import {
  extractChatId,
  isTerminal,
  parseNdjson,
  summarize,
  type ParsedEvent,
} from "./events.js";
import { readEvents } from "./storage.js";
import { notifyMessage, notifyResourceUpdated } from "./notifier.js";
import { registry } from "./registry.js";

import { loadConfig } from "../config.js";

async function cursorBin(): Promise<string> {
  const cfg = await loadConfig();
  return cfg.runtime.cursorBin;
}

export interface StartTurnArgs {
  message: string;
  kind: "spawn" | "resume";
}

type CursorChild = ChildProcessByStdio<null, Readable, Readable>;

export class CursorRunner {
  readonly runId: string;
  private child?: CursorChild;
  private turnPromise?: Promise<void>;

  constructor(runId: string) {
    this.runId = runId;
  }

  isBusy(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  async startTurn({ message, kind }: StartTurnArgs): Promise<TurnRecord> {
    if (this.isBusy()) {
      throw new Error(`run ${this.runId} is busy with turn ${this.currentTurnId()}`);
    }
    const meta = registry.getMeta(this.runId);
    if (!meta) throw new Error(`run ${this.runId} not found`);

    if (kind === "resume" && !meta.chatId) {
      throw new Error(`cannot resume run ${this.runId}: no chat_id captured yet`);
    }

    const turn: TurnRecord = {
      turnId: randomUUID(),
      startedAt: Date.now(),
      message,
      kind,
    };
    meta.currentTurn = turn;
    meta.turns.push(turn);
    meta.status = "running";
    meta.startedAt = meta.startedAt || turn.startedAt;
    await registry.updateMeta(meta);

    const argv = this.buildArgv(meta, message, kind);
    const bin = await cursorBin();
    const child = spawn(bin, argv, {
      cwd: meta.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }) as CursorChild;
    this.child = child;

    this.turnPromise = this.tail(child, turn.turnId, meta.timeoutMs).finally(() => {
      this.child = undefined;
    });

    return turn;
  }

  private currentTurnId(): string | undefined {
    return registry.getMeta(this.runId)?.currentTurn?.turnId;
  }

  private buildArgv(meta: RunMeta, message: string, kind: "spawn" | "resume"): string[] {
    const argv = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      meta.model,
      "--sandbox",
      meta.sandbox,
    ];
    // cursor-agent --mode only accepts "plan" | "ask"; "agent" is the default with no flag.
    if (meta.mode === "plan" || meta.mode === "ask") {
      argv.push("--mode", meta.mode);
    }
    // Permission maps to Cursor's approval + trust flags:
    //   read  -> read-only (force --mode ask when caller didn't pick plan/ask), no --trust
    //   auto  -> --trust + --auto-review (safe tools auto-approved, others prompt)
    //   trust -> --trust + --yolo (fully autonomous)
    if (meta.permission === "read") {
      if (meta.mode === "agent") argv.push("--mode", "ask");
    } else {
      argv.push("--trust");
      if (meta.permission === "trust") argv.push("--yolo");
      else argv.push("--auto-review");
    }
    if (kind === "resume" && meta.chatId) {
      argv.push("--resume", meta.chatId);
    }
    argv.push(message);
    return argv;
  }

  private async tail(
    child: CursorChild,
    turnId: string,
    timeoutMs: number | undefined,
  ): Promise<void> {
    const runId = this.runId;
    const buffer = { rest: "" };
    const eventsFd = await fs.open(eventsPath(runId), "a");
    let stderrBuf = "";
    let watchdog: NodeJS.Timeout | undefined;

    if (timeoutMs && timeoutMs > 0) {
      watchdog = setTimeout(() => {
        notifyMessage("warning", runId, `turn ${turnId} timed out after ${timeoutMs}ms`);
        try {
          child.kill("SIGTERM");
        } catch {}
      }, timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const events = parseNdjson(text, buffer);
      if (events.length) void this.persistEvents(eventsFd, turnId, events);
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
    });

    return new Promise<void>((resolve) => {
      child.on("close", async (code: number | null) => {
        if (watchdog) clearTimeout(watchdog);
        if (buffer.rest.trim()) {
          const events = parseNdjson("\n", buffer);
          if (events.length) await this.persistEvents(eventsFd, turnId, events);
        }
        await eventsFd.close().catch(() => {});
        await this.finalizeTurn(turnId, code, stderrBuf);
        resolve();
      });
      child.on("error", async (err: Error) => {
        if (watchdog) clearTimeout(watchdog);
        await eventsFd.close().catch(() => {});
        await this.recordError(turnId, err.message);
        resolve();
      });
    });
  }

  private async persistEvents(
    eventsFd: FileHandle,
    turnId: string,
    events: ParsedEvent[],
  ): Promise<void> {
    const meta = registry.getMeta(this.runId);
    if (!meta) return;
    let dirty = false;
    for (const ev of events) {
      meta.lastEventId += 1;
      meta.lastEventAt = Date.now();
      const stored = {
        eventId: meta.lastEventId,
        ts: meta.lastEventAt,
        turnId,
        type: ev.type,
        subtype: ev.subtype,
        raw: ev,
      };
      await eventsFd.appendFile(JSON.stringify(stored) + "\n", "utf8");
      if (!meta.chatId) {
        const cid = extractChatId(ev);
        if (cid) {
          meta.chatId = cid;
          dirty = true;
        }
      }
      if (isTerminal(ev)) {
        // Terminal event; process exit handler will finalize.
      }
    }
    if (dirty) await registry.updateMeta(meta);
    notifyResourceUpdated(`subagent://${this.runId}/events`);
  }

  private async finalizeTurn(
    turnId: string,
    exitCode: number | null,
    stderrTail: string,
  ): Promise<void> {
    const meta = registry.getMeta(this.runId);
    if (!meta) return;
    const turn = meta.turns.find((t) => t.turnId === turnId);
    if (turn) {
      turn.endedAt = Date.now();
      turn.exitCode = exitCode;
    }
    meta.currentTurn = undefined;

    if (exitCode === 0) {
      meta.status = "completed";
    } else if (exitCode === null) {
      meta.status = "cancelled";
    } else {
      meta.status = "failed";
      notifyMessage("error", this.runId, `cursor-agent exited ${exitCode}: ${stderrTail.slice(-500)}`);
    }
    meta.endedAt = Date.now();
    await registry.updateMeta(meta);
    notifyResourceUpdated(`subagent://${this.runId}/status`);

    // Build a rich terminal notification so Claude has the answer inline on its
    // next turn — no need for a follow-up get_subagent_result round trip in the
    // happy path.
    let summaryLine = "";
    try {
      const events = await readEvents(this.runId, 0, 10_000);
      const summary = summarize(events).replace(/\s+/g, " ").trim();
      if (summary) summaryLine = ` — ${summary.slice(0, 240)}${summary.length > 240 ? "…" : ""}`;
    } catch {}
    const level = meta.status === "completed" ? "info" : meta.status === "cancelled" ? "warning" : "error";
    notifyMessage(
      level,
      this.runId,
      `SUBAGENT ${this.runId} → ${meta.status}${summaryLine}`,
    );
  }

  private async recordError(turnId: string, message: string): Promise<void> {
    const meta = registry.getMeta(this.runId);
    if (!meta) return;
    meta.status = "failed";
    meta.endedAt = Date.now();
    const turn = meta.turns.find((t) => t.turnId === turnId);
    if (turn) {
      turn.endedAt = meta.endedAt;
      turn.exitCode = null;
    }
    meta.currentTurn = undefined;
    await registry.updateMeta(meta);
    notifyMessage("error", this.runId, `cursor-agent spawn error: ${message}`);
  }

  async cancel(): Promise<void> {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
    } catch {}
    await this.turnPromise?.catch(() => {});
  }

  async waitIdle(): Promise<void> {
    await this.turnPromise?.catch(() => {});
  }
}

export async function createRunMeta(args: {
  runId: string;
  model: string;
  mode: RunMeta["mode"];
  permission: RunMeta["permission"];
  sandbox: RunMeta["sandbox"];
  cwd: string;
  initialPrompt: string;
  timeoutMs?: number;
  spawnedBySession?: string;
}): Promise<RunMeta> {
  const now = Date.now();
  const meta: RunMeta = {
    runId: args.runId,
    status: "created",
    model: args.model,
    mode: args.mode,
    permission: args.permission,
    sandbox: args.sandbox,
    cwd: args.cwd,
    createdAt: now,
    startedAt: now,
    lastEventId: 0,
    turns: [],
    initialPrompt: args.initialPrompt,
    timeoutMs: args.timeoutMs,
    spawnedBySession: args.spawnedBySession,
  };
  // Ensure directory exists for events file.
  await fs.mkdir(runDir(meta.runId), { recursive: true });
  await writeMeta(meta);
  return meta;
}
