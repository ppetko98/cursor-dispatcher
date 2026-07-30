import type { Artifact, StoredEvent } from "../types.js";

export interface ParsedEvent {
  type?: string;
  subtype?: string;
  chat_id?: string;
  chatId?: string;
  session_id?: string;
  message?: unknown;
  result?: unknown;
  tool_call?: unknown;
  timestamp_ms?: number;
  [key: string]: unknown;
}

export function parseNdjson(chunk: string, buffer: { rest: string }): ParsedEvent[] {
  const combined = buffer.rest + chunk;
  const lines = combined.split("\n");
  buffer.rest = lines.pop() ?? "";
  const out: ParsedEvent[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ParsedEvent);
    } catch {
      out.push({ type: "unparsed", raw: t } as ParsedEvent);
    }
  }
  return out;
}

export function extractChatId(ev: ParsedEvent): string | undefined {
  return (
    ev.chat_id ??
    ev.chatId ??
    ev.session_id ??
    (typeof ev["chatId"] === "string" ? (ev["chatId"] as string) : undefined)
  );
}

export function isTerminal(ev: ParsedEvent): boolean {
  const t = ev.type;
  if (!t) return false;
  return t === "result" || t === "end" || t === "done" || t === "completion";
}

function assistantText(raw: ParsedEvent): string | undefined {
  const msg = raw.message as { content?: unknown } | undefined;
  if (!msg) return undefined;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? ((c as { text: string }).text)
          : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join("") : undefined;
  }
  return undefined;
}

// Cursor emits both incremental deltas (with top-level `timestamp_ms`) and a final
// consolidated assistant message per turn (no top-level `timestamp_ms`). The consolidated
// one is what we want in the summary.
export function summarize(events: StoredEvent[]): string {
  // Preference 1: last consolidated assistant message.
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i]?.raw as ParsedEvent | undefined;
    if (!raw || raw.type !== "assistant") continue;
    if (raw.timestamp_ms !== undefined) continue;
    const text = assistantText(raw);
    if (text) return text.slice(0, 4000);
  }
  // Preference 2: terminal result's `result` field.
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i]?.raw as ParsedEvent | undefined;
    if (raw?.type === "result" && typeof raw.result === "string") {
      return (raw.result as string).slice(0, 4000);
    }
  }
  // Preference 3: any last assistant text (deltas concatenated).
  const deltas: string[] = [];
  for (const ev of events) {
    const raw = ev.raw as ParsedEvent | undefined;
    if (raw?.type !== "assistant") continue;
    const text = assistantText(raw);
    if (text) deltas.push(text);
  }
  return deltas.join("").slice(0, 4000);
}

interface EditToolResult {
  editToolCall?: {
    args?: { path?: string };
    result?: {
      success?: {
        path?: string;
        linesAdded?: number;
        linesRemoved?: number;
        diffString?: string;
        message?: string;
      };
    };
  };
  shellToolCall?: {
    args?: { command?: string; description?: string };
    result?: {
      success?: {
        command?: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        executionTime?: number;
      };
    };
  };
}

export function collectArtifacts(events: StoredEvent[]): Artifact[] {
  const out: Artifact[] = [];
  for (const ev of events) {
    const raw = ev.raw as ParsedEvent | undefined;
    if (!raw || raw.type !== "tool_call" || raw.subtype !== "completed") continue;
    const tc = raw.tool_call as EditToolResult | undefined;
    if (!tc) continue;

    if (tc.editToolCall?.result?.success) {
      const s = tc.editToolCall.result.success;
      out.push({
        artifactId: `edit-${ev.eventId}`,
        type: "file",
        ref: s.path ?? tc.editToolCall.args?.path ?? "",
        metadata: {
          linesAdded: s.linesAdded,
          linesRemoved: s.linesRemoved,
          diff: s.diffString,
        },
      });
    } else if (tc.shellToolCall?.result?.success) {
      const s = tc.shellToolCall.result.success;
      out.push({
        artifactId: `shell-${ev.eventId}`,
        type: "log",
        ref: s.command ?? tc.shellToolCall.args?.command ?? "",
        metadata: {
          exitCode: s.exitCode,
          stdout: s.stdout,
          stderr: s.stderr,
          executionTimeMs: s.executionTime,
        },
      });
    }
  }
  return out;
}
