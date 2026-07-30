import { describe, expect, it } from "vitest";
import { extractChatId, isTerminal, parseNdjson } from "../src/runtime/events.js";

describe("parseNdjson", () => {
  it("parses complete lines and buffers the trailing partial", () => {
    const buffer = { rest: "" };
    const a = parseNdjson('{"type":"start"}\n{"type":"assistant","mes', buffer);
    expect(a).toEqual([{ type: "start" }]);
    expect(buffer.rest).toBe('{"type":"assistant","mes');

    const b = parseNdjson('sage":"hi"}\n{"type":"end"}\n', buffer);
    expect(b).toEqual([
      { type: "assistant", message: "hi" },
      { type: "end" },
    ]);
    expect(buffer.rest).toBe("");
  });

  it("keeps unparseable lines as an unparsed marker", () => {
    const buffer = { rest: "" };
    const events = parseNdjson("not-json\n", buffer);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("unparsed");
  });
});

describe("extractChatId", () => {
  it("finds chat_id / chatId / session_id variants", () => {
    expect(extractChatId({ chat_id: "abc" })).toBe("abc");
    expect(extractChatId({ chatId: "def" })).toBe("def");
    expect(extractChatId({ session_id: "ghi" })).toBe("ghi");
    expect(extractChatId({ type: "start" })).toBeUndefined();
  });
});

describe("isTerminal", () => {
  it("detects terminal event types", () => {
    expect(isTerminal({ type: "result" })).toBe(true);
    expect(isTerminal({ type: "end" })).toBe(true);
    expect(isTerminal({ type: "done" })).toBe(true);
    expect(isTerminal({ type: "assistant" })).toBe(false);
    expect(isTerminal({})).toBe(false);
  });
});
