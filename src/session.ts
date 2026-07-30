import { randomUUID } from "node:crypto";

let cached: string | undefined;

// Resolves the id used to tag runs with `spawnedBySession`. Sources, in order:
//   1. CLAUDE_SESSION_ID env (if Claude Code exposes it to child MCP servers)
//   2. CLAUDECODE_SESSION_ID env (alternate name seen in some releases)
//   3. A UUID generated once per MCP server instance
//
// The hook script derives session id from the JSON stdin payload Claude Code
// sends it; when both routes ultimately point at CLAUDE_SESSION_ID they agree,
// and the hook can filter runs down to just the current session's work. When
// they diverge (env var absent), the hook has a safety-net fallback.
export function harnessSessionId(): string {
  if (!cached) {
    cached =
      process.env["CLAUDE_SESSION_ID"] ??
      process.env["CLAUDECODE_SESSION_ID"] ??
      randomUUID();
  }
  return cached;
}

export function resetSessionIdForTests(): void {
  cached = undefined;
}
