#!/usr/bin/env node
// UserPromptSubmit hook for cursor-dispatcher. Runs before each of the user's
// prompts hits Claude. Scans the harness runs directory for terminal-status
// transitions in runs spawned by this Claude Code session and emits a short
// line per new transition to stdout — Claude Code injects that into the turn
// context so Claude reacts on the next reply without polling.
//
// Filtering:
//   1. Prefer session_id from stdin JSON (Claude Code passes it), matched
//      against meta.json.spawnedBySession (stamped by the MCP server).
//   2. If we can't determine a session id, fall back to reporting all runs.
//   3. Per-session state file tracks (runId → last-reported status) so we
//      don't spam duplicates on subsequent prompts.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HARNESS_HOME =
  process.env["CURSOR_HARNESS_HOME"] ??
  path.join(os.homedir(), ".claude-cursor-harness");
const RUNS_DIR = path.join(HARNESS_HOME, "runs");
const STATE_DIR = path.join(HARNESS_HOME, "hook-state");
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadRuns() {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = readJsonOr(path.join(RUNS_DIR, e.name, "meta.json"), null);
    if (meta) runs.push(meta);
  }
  return runs;
}

async function main() {
  const stdin = await readStdin();
  const payload = stdin ? readJsonOr(null, {}) ?? {} : {};
  let sessionId = null;
  try {
    const parsed = stdin ? JSON.parse(stdin) : {};
    sessionId =
      parsed.session_id ??
      parsed.sessionId ??
      parsed.session?.id ??
      null;
  } catch {}

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = path.join(STATE_DIR, `${sessionId ?? "global"}.json`);
  const state = readJsonOr(stateFile, { reported: {} });
  if (!state.reported) state.reported = {};

  const messages = [];
  for (const meta of loadRuns()) {
    if (!TERMINAL.has(meta.status)) continue;
    if (state.reported[meta.runId] === meta.status) continue;
    // Session scoping: Claude Code doesn't pass a shared session id to child
    // MCP servers today, so the MCP server generates its own random UUID and
    // the ids never match. Rather than silently drop those runs, tag them as
    // [unlinked] so they still surface. A user running two concurrent Claude
    // sessions will see the other's runs marked [unlinked] — noisy but never
    // a missed report.
    const unlinked =
      sessionId && meta.spawnedBySession && meta.spawnedBySession !== sessionId;
    const summary = (meta.summary ?? "")
      .toString()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    const line = `${unlinked ? "[unlinked] " : ""}SUBAGENT ${meta.runId} → ${meta.status}${
      summary ? ` — ${summary}` : ""
    }`;
    messages.push(line);
    state.reported[meta.runId] = meta.status;
  }

  if (messages.length) {
    process.stdout.write(
      `[cursor-dispatcher] subagent updates since last turn:\n${messages
        .map((m) => `- ${m}`)
        .join("\n")}\n`,
    );
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

main().catch((err) => {
  // Never fail loudly — a broken hook shouldn't wedge Claude's prompt path.
  process.stderr.write(`[cursor-dispatcher hook] ${err?.message ?? String(err)}\n`);
  process.exit(0);
});
