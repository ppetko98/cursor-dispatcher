import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SandboxMode } from "./types.js";

export interface HarnessConfig {
  home: string;
  runtime: {
    cursorBin: string;
  };
  policy: {
    models: string[];
    defaultModel: string;
    cwdRoot: string;
    sandbox: SandboxMode;
  };
  retention: {
    compressAfterDays: number;
    maxAgeDays: number;
    maxRuns: number;
    pruneOnStartup: boolean;
    pruneOnSpawn: boolean;
  };
}

interface FileConfig {
  runtime?: Partial<HarnessConfig["runtime"]>;
  policy?: Partial<HarnessConfig["policy"]>;
  retention?: Partial<HarnessConfig["retention"]>;
}

const DEFAULT_MODELS = [
  "auto",
  "gpt-5.2",
  "claude-opus-5-thinking-high",
  "claude-opus-4-8-thinking-high",
  "composer-2.5",
];

function defaults(home: string): HarnessConfig {
  return {
    home,
    runtime: { cursorBin: "cursor-agent" },
    policy: {
      models: [...DEFAULT_MODELS],
      defaultModel: "auto",
      cwdRoot: path.join(os.homedir(), "workspace"),
      sandbox: "enabled",
    },
    retention: {
      compressAfterDays: 7,
      maxAgeDays: 14,
      maxRuns: 200,
      pruneOnStartup: true,
      pruneOnSpawn: true,
    },
  };
}

function harnessHome(): string {
  return process.env["CURSOR_HARNESS_HOME"] ?? path.join(os.homedir(), ".claude-cursor-harness");
}

async function readFileConfig(home: string): Promise<FileConfig> {
  const file = path.join(home, "config.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as FileConfig;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`failed to read ${file}: ${(err as Error).message}`);
  }
}

function envList(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

let cached: HarnessConfig | undefined;

export async function loadConfig(force = false): Promise<HarnessConfig> {
  if (cached && !force) return cached;
  const home = harnessHome();
  const file = await readFileConfig(home);
  const base = defaults(home);

  const merged: HarnessConfig = {
    home,
    runtime: {
      cursorBin:
        process.env["CURSOR_HARNESS_BIN"] ?? file.runtime?.cursorBin ?? base.runtime.cursorBin,
    },
    policy: {
      models: envList("CURSOR_HARNESS_MODELS") ?? file.policy?.models ?? base.policy.models,
      defaultModel:
        process.env["CURSOR_HARNESS_DEFAULT_MODEL"] ??
        file.policy?.defaultModel ??
        base.policy.defaultModel,
      cwdRoot:
        process.env["CURSOR_HARNESS_CWD_ROOT"] ?? file.policy?.cwdRoot ?? base.policy.cwdRoot,
      sandbox:
        (process.env["CURSOR_HARNESS_SANDBOX"] as SandboxMode | undefined) ??
        file.policy?.sandbox ??
        base.policy.sandbox,
    },
    retention: {
      compressAfterDays:
        envNum("CURSOR_HARNESS_COMPRESS_AFTER_DAYS") ??
        file.retention?.compressAfterDays ??
        base.retention.compressAfterDays,
      maxAgeDays:
        envNum("CURSOR_HARNESS_MAX_AGE_DAYS") ??
        file.retention?.maxAgeDays ??
        base.retention.maxAgeDays,
      maxRuns:
        envNum("CURSOR_HARNESS_MAX_RUNS") ??
        file.retention?.maxRuns ??
        base.retention.maxRuns,
      pruneOnStartup:
        envBool("CURSOR_HARNESS_PRUNE_ON_STARTUP") ??
        file.retention?.pruneOnStartup ??
        base.retention.pruneOnStartup,
      pruneOnSpawn:
        envBool("CURSOR_HARNESS_PRUNE_ON_SPAWN") ??
        file.retention?.pruneOnSpawn ??
        base.retention.pruneOnSpawn,
    },
  };
  cached = merged;
  return merged;
}

export function resetConfigCache(): void {
  cached = undefined;
}
