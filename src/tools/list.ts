import { z } from "zod";
import { ListInput } from "./schemas.js";
import { registry } from "../runtime/registry.js";

export async function listSubagents(rawInput: unknown): Promise<{
  runs: Array<{
    run_id: string;
    status: string;
    model: string;
    mode: string;
    started_at: number;
    ended_at?: number;
  }>;
}> {
  const input = ListInput.parse(rawInput ?? {}) as z.infer<typeof ListInput>;
  const runs = registry.list({ status: input.status, since: input.since }).map((m) => ({
    run_id: m.runId,
    status: m.status,
    model: m.model,
    mode: m.mode,
    started_at: m.startedAt,
    ended_at: m.endedAt,
  }));
  return { runs };
}
