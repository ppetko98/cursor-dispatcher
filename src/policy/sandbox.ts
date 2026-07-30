import path from "node:path";
import { promises as fs } from "node:fs";
import type { SandboxMode } from "../types.js";
import { loadConfig } from "../config.js";

export async function defaultSandbox(): Promise<SandboxMode> {
  const cfg = await loadConfig();
  return cfg.policy.sandbox;
}

export async function resolveAndValidateCwd(cwd: string | undefined): Promise<string> {
  const cfg = await loadConfig();
  const root = path.resolve(cfg.policy.cwdRoot);
  const target = path.resolve(cwd ?? root);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `cwd "${target}" is outside allowed root "${root}". ` +
        `Set CURSOR_HARNESS_CWD_ROOT or edit ~/.claude-cursor-harness/config.json to change.`,
    );
  }
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`cwd "${target}" does not exist or is not a directory`);
  }
  return target;
}
