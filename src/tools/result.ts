import { z } from "zod";
import { RunIdInput } from "./schemas.js";
import { registry } from "../runtime/registry.js";
import { readEvents } from "../runtime/storage.js";
import { collectArtifacts, summarize } from "../runtime/events.js";
import type { CompletionPayload } from "../types.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

export async function getSubagentResult(rawInput: unknown): Promise<CompletionPayload> {
  const input = RunIdInput.parse(rawInput) as z.infer<typeof RunIdInput>;
  const meta = registry.getMeta(input.run_id);
  if (!meta) throw new Error(`unknown run_id: ${input.run_id}`);
  if (!TERMINAL.has(meta.status)) {
    throw new Error(`run ${input.run_id} not terminal yet (status=${meta.status})`);
  }
  const events = await readEvents(input.run_id, 0, 10_000);
  return {
    status: meta.status,
    summary: summarize(events),
    artifacts: collectArtifacts(events),
    openQuestions: [],
    nextAction: undefined,
  };
}
