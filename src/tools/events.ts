import { z } from "zod";
import { EventsInput } from "./schemas.js";
import { readEvents } from "../runtime/storage.js";
import { registry } from "../runtime/registry.js";

export async function getSubagentEvents(rawInput: unknown): Promise<{
  events: unknown[];
  next_since: number;
}> {
  const input = EventsInput.parse(rawInput) as z.infer<typeof EventsInput>;
  if (!registry.getMeta(input.run_id)) {
    throw new Error(`unknown run_id: ${input.run_id}`);
  }
  const events = await readEvents(
    input.run_id,
    input.since_event_id ?? 0,
    input.limit ?? 200,
  );
  const last = events[events.length - 1];
  const nextSince = last?.eventId ?? input.since_event_id ?? 0;
  return { events, next_since: nextSince };
}
