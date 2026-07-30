export type RunStatus =
  | "created"
  | "running"
  | "waiting_on_parent"
  | "waiting_on_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type CursorMode = "agent" | "plan" | "ask";
export type SandboxMode = "enabled" | "disabled";
export type PermissionMode = "read" | "auto" | "trust";

export interface SpawnOptions {
  prompt: string;
  model?: string;
  mode?: CursorMode;
  permission?: PermissionMode;
  cwd?: string;
  sandbox?: SandboxMode;
  contextFiles?: string[];
  timeoutMs?: number;
}

export interface TurnRecord {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  message: string;
  kind: "spawn" | "resume";
}

export type RetentionState = "full" | "compressed";

export interface RunMeta {
  runId: string;
  chatId?: string;
  status: RunStatus;
  model: string;
  mode: CursorMode;
  permission: PermissionMode;
  sandbox: SandboxMode;
  cwd: string;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  lastEventAt?: number;
  lastEventId: number;
  currentTurn?: TurnRecord;
  turns: TurnRecord[];
  initialPrompt: string;
  timeoutMs?: number;
  // Retention state: "full" while events.ndjson lives on disk, "compressed" after
  // pruning has gzipped it. `summary` is materialized at compression time so meta.json
  // stays self-describing even after events are archived.
  retentionState?: RetentionState;
  compressedAt?: number;
  summary?: string;
  // Id of the Claude Code session that spawned this run. Used by the
  // UserPromptSubmit plugin hook to scope reports to just this session's work.
  spawnedBySession?: string;
}

export interface StoredEvent {
  eventId: number;
  ts: number;
  turnId: string;
  raw: unknown;
  type?: string;
  subtype?: string;
}

export interface CompletionPayload {
  status: RunStatus;
  summary: string;
  artifacts: Artifact[];
  testResults?: unknown;
  openQuestions: string[];
  nextAction?: string;
}

export interface Artifact {
  artifactId: string;
  type: "file" | "log" | "diff" | "other";
  ref: string;
  metadata?: Record<string, unknown>;
}

export interface StoredMessage {
  messageId: string;
  runId: string;
  turnId: string;
  direction: "parent_to_subagent" | "subagent_to_parent";
  content: string;
  timestamp: number;
}
