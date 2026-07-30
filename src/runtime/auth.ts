import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";

export interface AuthState {
  authenticated: boolean;
  method?: "api_key" | "login";
  user?: string;
  reason?: string;
  checkedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: AuthState | undefined;

function runStatus(bin: string, timeoutMs = 4000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["status"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const to = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(to);
      resolve({ code: -1, stdout, stderr: (err as Error).message });
    });
  });
}

export async function checkCursorAuth(opts: { force?: boolean } = {}): Promise<AuthState> {
  if (!opts.force && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached;

  // Env-key shortcut — cursor-agent accepts CURSOR_API_KEY, so if it's set we
  // trust it without shelling out (the CLI would still be authoritative on a
  // real failure; spawn_subagent will surface any downstream auth error).
  if (process.env["CURSOR_API_KEY"]) {
    cached = { authenticated: true, method: "api_key", checkedAt: Date.now() };
    return cached;
  }

  const cfg = await loadConfig();
  const { code, stdout, stderr } = await runStatus(cfg.runtime.cursorBin);
  if (code === -1) {
    cached = {
      authenticated: false,
      reason: `cursor-agent not found or failed to start (${stderr.trim() || "unknown error"})`,
      checkedAt: Date.now(),
    };
    return cached;
  }

  const combined = `${stdout}\n${stderr}`;
  const loggedInMatch = combined.match(/Logged in as\s+(\S+)/i);
  if (code === 0 && loggedInMatch) {
    cached = {
      authenticated: true,
      method: "login",
      user: loggedInMatch[1],
      checkedAt: Date.now(),
    };
    return cached;
  }

  cached = {
    authenticated: false,
    reason: combined.trim().slice(0, 500) || `cursor-agent status exited ${code}`,
    checkedAt: Date.now(),
  };
  return cached;
}

export function resetAuthCacheForTests(): void {
  cached = undefined;
}

export function authErrorMessage(state: AuthState): string {
  const detail = state.reason ? ` (${state.reason})` : "";
  return (
    `cursor-agent is not authenticated${detail}. ` +
    `Run \`cursor-agent login\` in a terminal (or use the /cursor-login command), ` +
    `or set the CURSOR_API_KEY env var. See https://cursor.com/docs/cli/overview.`
  );
}
