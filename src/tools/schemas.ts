import { z } from "zod";

export const SpawnInput = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  mode: z.enum(["agent", "plan", "ask"]).optional(),
  permission: z.enum(["read", "auto", "trust"]).optional(),
  cwd: z.string().optional(),
  sandbox: z.enum(["enabled", "disabled"]).optional(),
  context_files: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

export const MessageInput = z.object({
  run_id: z.string(),
  message: z.string().min(1),
});

export const RunIdInput = z.object({ run_id: z.string() });

export const EventsInput = z.object({
  run_id: z.string(),
  since_event_id: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const ListInput = z.object({
  status: z
    .enum([
      "created",
      "running",
      "waiting_on_parent",
      "waiting_on_user",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ])
    .optional(),
  since: z.number().int().nonnegative().optional(),
});
