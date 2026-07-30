import { loadConfig } from "../config.js";

export async function allowedModels(): Promise<string[]> {
  const cfg = await loadConfig();
  return [...cfg.policy.models];
}

export async function defaultModel(): Promise<string> {
  const cfg = await loadConfig();
  return cfg.policy.defaultModel || cfg.policy.models[0] || "auto";
}

export async function assertModelAllowed(model: string): Promise<void> {
  const allow = await allowedModels();
  if (!allow.includes(model)) {
    throw new Error(
      `model "${model}" not in allowlist [${allow.join(", ")}]. ` +
        `Set CURSOR_HARNESS_MODELS or edit ~/.claude-cursor-harness/config.json to change.`,
    );
  }
}
