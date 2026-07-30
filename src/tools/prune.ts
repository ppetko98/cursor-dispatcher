import { z } from "zod";
import { pruneRuns, type PruneResult } from "../runtime/cleanup.js";

const PruneInput = z.object({
  compress_after_days: z.number().min(0).optional(),
  max_age_days: z.number().min(0).optional(),
  keep_last: z.number().int().min(0).optional(),
  dry_run: z.boolean().optional(),
});

export async function pruneSubagents(rawInput: unknown): Promise<PruneResult> {
  const input = PruneInput.parse(rawInput ?? {});
  return pruneRuns({
    compressAfterDays: input.compress_after_days,
    maxAgeDays: input.max_age_days,
    keepLast: input.keep_last,
    dryRun: input.dry_run,
  });
}
