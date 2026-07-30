import { describe, expect, it } from "vitest";
import { collectArtifacts, summarize } from "../src/runtime/events.js";
import type { StoredEvent } from "../src/types.js";

function ev(id: number, raw: unknown): StoredEvent {
  return { eventId: id, ts: id * 1000, turnId: "t", raw };
}

describe("summarize", () => {
  it("prefers the consolidated assistant message (no timestamp_ms)", () => {
    const events: StoredEvent[] = [
      ev(1, { type: "assistant", message: { content: [{ text: "Creat" }] }, timestamp_ms: 1 }),
      ev(2, { type: "assistant", message: { content: [{ text: "ing." }] }, timestamp_ms: 2 }),
      ev(3, { type: "assistant", message: { content: [{ text: "Creating." }] } }),
      ev(4, { type: "result", subtype: "success", result: "Creating.Creating." }),
    ];
    expect(summarize(events)).toBe("Creating.");
  });

  it("falls back to result.result when no consolidated assistant present", () => {
    const events: StoredEvent[] = [
      ev(1, { type: "assistant", message: { content: [{ text: "a" }] }, timestamp_ms: 1 }),
      ev(2, { type: "assistant", message: { content: [{ text: "b" }] }, timestamp_ms: 2 }),
      ev(3, { type: "result", subtype: "success", result: "final answer" }),
    ];
    expect(summarize(events)).toBe("final answer");
  });

  it("returns empty string when nothing usable", () => {
    expect(summarize([ev(1, { type: "system", subtype: "init" })])).toBe("");
  });
});

describe("collectArtifacts", () => {
  it("captures edit tool calls as file artifacts", () => {
    const events: StoredEvent[] = [
      ev(10, {
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          editToolCall: {
            args: { path: "/tmp/x.py" },
            result: {
              success: {
                path: "/tmp/x.py",
                linesAdded: 1,
                linesRemoved: 0,
                diffString: "+print('hi')",
              },
            },
          },
        },
      }),
    ];
    const arts = collectArtifacts(events);
    expect(arts).toHaveLength(1);
    expect(arts[0]?.type).toBe("file");
    expect(arts[0]?.ref).toBe("/tmp/x.py");
    expect(arts[0]?.metadata?.["linesAdded"]).toBe(1);
  });

  it("captures shell tool calls as log artifacts", () => {
    const events: StoredEvent[] = [
      ev(11, {
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          shellToolCall: {
            args: { command: "python3 x.py" },
            result: {
              success: { command: "python3 x.py", exitCode: 0, stdout: "hi\n", stderr: "" },
            },
          },
        },
      }),
    ];
    const arts = collectArtifacts(events);
    expect(arts).toHaveLength(1);
    expect(arts[0]?.type).toBe("log");
    expect(arts[0]?.metadata?.["stdout"]).toBe("hi\n");
  });

  it("ignores in-flight or non-tool events", () => {
    const events: StoredEvent[] = [
      ev(1, { type: "assistant", message: { content: [{ text: "hi" }] } }),
      ev(2, { type: "tool_call", subtype: "started", tool_call: { editToolCall: {} } }),
    ];
    expect(collectArtifacts(events)).toEqual([]);
  });
});
