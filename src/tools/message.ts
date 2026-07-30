import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MessageInput } from "./schemas.js";
import { registry } from "../runtime/registry.js";
import { appendMessage } from "../runtime/storage.js";
import { CursorRunner } from "../runtime/runner.js";

export async function sendSubagentMessage(rawInput: unknown): Promise<{
  status: string;
  turn_id: string;
}> {
  const input = MessageInput.parse(rawInput) as z.infer<typeof MessageInput>;
  const entry = registry.get(input.run_id);
  if (!entry) throw new Error(`unknown run_id: ${input.run_id}`);
  // Rehydrate a runner if the server restarted since spawn (state lives on disk;
  // Cursor's --resume can still reach the chat as long as chat_id was captured).
  if (!entry.runner) {
    if (!entry.meta.chatId) {
      throw new Error(
        `run ${input.run_id} has no chat_id (never started or failed pre-init); cannot resume`,
      );
    }
    entry.runner = new CursorRunner(input.run_id);
  }
  if (entry.runner.isBusy()) {
    throw new Error(`run ${input.run_id} is busy; wait for the current turn to complete`);
  }
  const turn = await entry.runner.startTurn({ message: input.message, kind: "resume" });
  await appendMessage({
    messageId: randomUUID(),
    runId: input.run_id,
    turnId: turn.turnId,
    direction: "parent_to_subagent",
    content: input.message,
    timestamp: turn.startedAt,
  });
  const meta = registry.getMeta(input.run_id)!;
  return { status: meta.status, turn_id: turn.turnId };
}
