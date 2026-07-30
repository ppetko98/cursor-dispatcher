import { z } from "zod";
import { RunIdInput } from "./schemas.js";
import { registry } from "../runtime/registry.js";

export async function cancelSubagent(rawInput: unknown): Promise<{
  run_id: string;
  status: string;
}> {
  const input = RunIdInput.parse(rawInput) as z.infer<typeof RunIdInput>;
  const entry = registry.get(input.run_id);
  if (!entry) throw new Error(`unknown run_id: ${input.run_id}`);
  if (entry.runner) await entry.runner.cancel();
  const meta = registry.getMeta(input.run_id)!;
  return { run_id: meta.runId, status: meta.status };
}
