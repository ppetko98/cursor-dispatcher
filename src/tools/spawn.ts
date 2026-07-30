import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SpawnInput } from "./schemas.js";
import { defaultModel, assertModelAllowed } from "../policy/models.js";
import { defaultSandbox, resolveAndValidateCwd } from "../policy/sandbox.js";
import { CursorRunner, createRunMeta } from "../runtime/runner.js";
import { registry } from "../runtime/registry.js";
import { appendMessage } from "../runtime/storage.js";
import { notifyMessage } from "../runtime/notifier.js";
import { pruneRuns } from "../runtime/cleanup.js";
import { loadConfig } from "../config.js";
import { harnessSessionId } from "../session.js";
import { authErrorMessage, checkCursorAuth } from "../runtime/auth.js";

export async function spawnSubagent(rawInput: unknown): Promise<{
  run_id: string;
  chat_id?: string;
  status: string;
}> {
  const input = SpawnInput.parse(rawInput) as z.infer<typeof SpawnInput>;

  const auth = await checkCursorAuth();
  if (!auth.authenticated) throw new Error(authErrorMessage(auth));

  const model = input.model ?? (await defaultModel());
  await assertModelAllowed(model);
  const cwd = await resolveAndValidateCwd(input.cwd);
  const sandbox = input.sandbox ?? (await defaultSandbox());
  const mode = input.mode ?? "agent";
  const permission = input.permission ?? "auto";

  const runId = randomUUID();
  const meta = await createRunMeta({
    runId,
    model,
    mode,
    permission,
    sandbox,
    cwd,
    initialPrompt: input.prompt,
    timeoutMs: input.timeout_ms,
    spawnedBySession: harnessSessionId(),
  });

  const runner = new CursorRunner(runId);
  await registry.create(meta, runner);

  const turn = await runner.startTurn({ message: input.prompt, kind: "spawn" });
  await appendMessage({
    messageId: randomUUID(),
    runId,
    turnId: turn.turnId,
    direction: "parent_to_subagent",
    content: input.prompt,
    timestamp: turn.startedAt,
  });
  notifyMessage("info", runId, `spawned cursor-agent (model=${model}, mode=${mode})`);

  const latest = registry.getMeta(runId)!;

  const cfg = await loadConfig();
  if (cfg.retention.pruneOnSpawn) {
    // Fire-and-forget; we don't want cleanup latency in spawn's response.
    void pruneRuns().catch(() => {});
  }

  return { run_id: runId, chat_id: latest.chatId, status: latest.status };
}
