import { z } from "zod";
import { RunIdInput } from "./schemas.js";
import { registry } from "../runtime/registry.js";

export async function getSubagentStatus(rawInput: unknown): Promise<{
  run_id: string;
  status: string;
  model: string;
  mode: string;
  chat_id?: string;
  started_at: number;
  last_event_at?: number;
  ended_at?: number;
  current_turn?: string;
  last_event_id: number;
}> {
  const input = RunIdInput.parse(rawInput) as z.infer<typeof RunIdInput>;
  const meta = registry.getMeta(input.run_id);
  if (!meta) throw new Error(`unknown run_id: ${input.run_id}`);
  return {
    run_id: meta.runId,
    status: meta.status,
    model: meta.model,
    mode: meta.mode,
    chat_id: meta.chatId,
    started_at: meta.startedAt,
    last_event_at: meta.lastEventAt,
    ended_at: meta.endedAt,
    current_turn: meta.currentTurn?.turnId,
    last_event_id: meta.lastEventId,
  };
}
