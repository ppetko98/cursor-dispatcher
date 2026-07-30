# cursor-dispatcher

An MCP server + Claude Code plugin that lets **Claude spawn Cursor subagents** as async, bounded workers.

Claude delegates a task, gets a `run_id` back immediately, and continues talking to the user. When the subagent finishes, a plugin hook injects the outcome into Claude's next turn — no polling, no blocked chat.

> The original design spec lives in [`PRD.md`](./PRD.md).

---

## What it does

- **Spawn** Cursor subagents on demand (`spawn_subagent`).
- **Message** them mid-run via `--resume=<chat_id>` (`send_subagent_message`).
- **Stream** their NDJSON events to disk as they run (readable via `get_subagent_events` or the `subagent://<run_id>/events` MCP resource).
- **Synthesize** a structured completion payload — status, summary, artifacts (file edits + shell tool calls with stdout/stderr) — via `get_subagent_result`.
- **Cancel**, **list**, **prune**.
- **Retain** run history under `~/.claude-cursor-harness/` with tiered compression (7d → gzip, 14d → delete) and an LRU cap.
- **Notify** Claude asynchronously via an `UserPromptSubmit` hook so subagent completions surface without polling.
- **Preflight** cursor-agent auth on startup + every spawn; refuses with an actionable error if not logged in.

---

## Requirements

- Node ≥ 20 (for the MCP server)
- [`cursor-agent`](https://cursor.com/docs/cli/overview) installed on `$PATH`, authenticated via `cursor-agent login` **or** `CURSOR_API_KEY` env var
- Claude Code (for the plugin — hooks, skill, slash command)

---

## Install

### Public (via GitHub marketplace)

From inside Claude Code:
```
/plugin marketplace add ppetko98/cursor-dispatcher
/plugin install cursor-dispatcher@cursor-dispatcher
/reload-plugins
```
That's it — Claude Code clones the repo, wires up the MCP server, hook, skill, and slash command. You still need `cursor-agent` installed on `$PATH` and authenticated (see `/cursor-login`).

### Local (for dev)

```bash
git clone https://github.com/ppetko98/cursor-dispatcher.git
cd cursor-dispatcher
npm install
npm run build

# From Claude Code:
/plugin marketplace add /absolute/path/to/cursor-dispatcher
/plugin install cursor-dispatcher@cursor-dispatcher
/reload-plugins
```

Then verify:
```
/mcp                     # cursor-dispatcher should be listed
/hooks                   # UserPromptSubmit → on-user-prompt.mjs
Skill: cursor-dispatcher:cursor-subagent
Slash: /cursor-login
```

### Without the plugin (MCP-only)

If you only want the MCP tools without the hook + skill:
```bash
claude mcp add cursor-dispatcher -- node /absolute/path/to/cursor-dispatcher/dist/server.js
```

---

## Usage (from Claude)

Typical delegation flow, driven by the shipped `cursor-subagent` skill:

1. **You:** "have cursor scaffold a fastify server under `./demo`."
2. **Claude:** calls `spawn_subagent({ prompt: "...", cwd: "...", permission: "auto" })` → returns `run_id` instantly. Tells you it's running and moves on.
3. **Subagent** runs `cursor-agent -p --output-format stream-json --resume-support` in the background, streaming NDJSON events to `~/.claude-cursor-harness/runs/<run_id>/events.ndjson`.
4. **You** send any next message — the `UserPromptSubmit` hook scans for terminal transitions and prepends `SUBAGENT <id> → completed — <summary>` to your prompt.
5. **Claude** sees the update inline in the very next turn and reports back with the outcome (files edited, shell output, etc.).

Follow-ups on the same run use `send_subagent_message` — it re-invokes `cursor-agent --resume=<chat_id>` so the subagent picks up where it left off.

---

## Permission model

The harness maps the parent Claude session's own posture to Cursor's approval flags:

| `permission` value | Cursor flags | When to pick |
|---|---|---|
| `read` | `--mode ask` (no `--trust`) | Parent Claude is in plan / read-only mode. Subagent cannot write files or run shell commands. |
| `auto` **(default)** | `--trust --auto-review` | Default. Server-side classifier auto-approves safe tool calls; unsafe ones would prompt (and effectively hang in headless mode). |
| `trust` | `--trust --yolo` | Fully autonomous. Use only when the user has explicitly said "let it rip." |

Model must come from an allowlist (default: `auto, gpt-5.2, claude-opus-5-thinking-high, claude-opus-4-8-thinking-high, composer-2.5`). Working directory must live under a configured root (default `~/workspace`).

---

## MCP tools

All tools live under the `cursor-dispatcher` MCP server.

| Tool | Purpose |
|---|---|
| `spawn_subagent` | Launch a new subagent. Returns `{ run_id, chat_id?, status }` immediately. |
| `send_subagent_message` | Send a follow-up message to a run (resumes the same Cursor chat). |
| `get_subagent_status` | Cheap poll: status + last event id + current turn. |
| `get_subagent_events` | Fetch NDJSON events since a given `event_id`. |
| `get_subagent_result` | Terminal-run completion payload: `{ status, summary, artifacts: [{ type, ref, metadata }] }`. |
| `list_subagents` | Filterable list of runs known to the harness. |
| `cancel_subagent` | SIGTERM the child. |
| `prune_subagents` | Manual cleanup: `{ compress_after_days?, max_age_days?, keep_last?, dry_run? }`. |

Resources are exposed at `subagent://<run_id>/status` and `subagent://<run_id>/events`, with `notifications/resources/updated` fired on each new batch of events.

---

## Configuration

Precedence: **env var > `~/.claude-cursor-harness/config.json` > built-in defaults.**

Example config file:
```json
{
  "runtime": { "cursorBin": "cursor-agent" },
  "policy": {
    "models": ["auto", "gpt-5.2"],
    "defaultModel": "auto",
    "cwdRoot": "/Users/you/workspace",
    "sandbox": "enabled"
  },
  "retention": {
    "compressAfterDays": 7,
    "maxAgeDays": 14,
    "maxRuns": 200,
    "pruneOnStartup": true,
    "pruneOnSpawn": true
  }
}
```

Env-var overrides:

| Env | Config path |
|---|---|
| `CURSOR_HARNESS_HOME` | root data dir (default `~/.claude-cursor-harness`) |
| `CURSOR_HARNESS_BIN` | `runtime.cursorBin` |
| `CURSOR_HARNESS_MODELS` | `policy.models` (comma-separated) |
| `CURSOR_HARNESS_DEFAULT_MODEL` | `policy.defaultModel` |
| `CURSOR_HARNESS_CWD_ROOT` | `policy.cwdRoot` |
| `CURSOR_HARNESS_SANDBOX` | `policy.sandbox` |
| `CURSOR_HARNESS_COMPRESS_AFTER_DAYS` | `retention.compressAfterDays` |
| `CURSOR_HARNESS_MAX_AGE_DAYS` | `retention.maxAgeDays` |
| `CURSOR_HARNESS_MAX_RUNS` | `retention.maxRuns` |
| `CURSOR_HARNESS_PRUNE_ON_STARTUP` | `retention.pruneOnStartup` |
| `CURSOR_HARNESS_PRUNE_ON_SPAWN` | `retention.pruneOnSpawn` |
| `CURSOR_API_KEY` | cursor-agent auth (bypasses login) |

---

## Retention

Each run's data lives under `~/.claude-cursor-harness/runs/<run_id>/`:

```
runs/<run_id>/
├── meta.json                 # RunMeta (status, model, chat_id, session, summary, retention state)
├── events.ndjson             # NDJSON of every parsed cursor-agent event
├── messages.ndjson           # Parent ↔ subagent message log
└── artifacts/                # Reserved for future materialized outputs
```

Lifecycle:

- **0–7 days:** kept fully.
- **7–14 days:** `events.ndjson` and `messages.ndjson` gzipped in place. `meta.json` gains `retentionState: "compressed"`, `compressedAt`, and a materialized `summary` so it stays self-describing. `get_subagent_result` still works — `readEvents` transparently gunzips.
- **>14 days:** entire run dir deleted.
- **LRU:** if more than `maxRuns` terminal survivors remain, the oldest (by `endedAt`) are deleted regardless of age.
- **Non-terminal runs are never touched.**

Triggers: startup (`registry.load`), after every `spawn_subagent`, and on-demand via `prune_subagents`.

---

## The plugin bundle

Under `plugin/`:

- **MCP server** — same code that ships as `dist/server.js`.
- **Skill** `cursor-subagent` (`plugin/skills/cursor-subagent/SKILL.md`) — teaches Claude the non-blocking pattern, permission mapping, and follow-up flow.
- **Slash command** `/cursor-login` (`plugin/commands/cursor-login.md`) — walks the user through interactive login or `CURSOR_API_KEY` setup.
- **Hook** `UserPromptSubmit` (`plugin/hooks/on-user-prompt.mjs`) — before each of your prompts, scans for new terminal transitions and injects a summary block. Filters to this Claude Code session where possible; falls back to reporting mismatched-session runs as `[unlinked]` so nothing is silently missed.

---

## Development

```bash
npm install
npm run build          # tsc
npm test               # vitest (34 tests)
npm run lint           # tsc --noEmit
```

Repo layout:

```
src/
├── server.ts          # MCP stdio entrypoint
├── config.ts          # Config layer (env + config.json)
├── session.ts         # Per-server session id resolver
├── types.ts
├── runtime/
│   ├── runner.ts      # Cursor CLI child process
│   ├── registry.ts    # In-memory + disk-backed run registry
│   ├── storage.ts     # ~/.claude-cursor-harness/ layout + gzip helpers
│   ├── events.ts      # NDJSON parser, summary + artifact synthesis
│   ├── cleanup.ts     # Retention engine (compress/delete/LRU)
│   ├── auth.ts        # cursor-agent status preflight
│   └── notifier.ts    # MCP notifications helpers
├── tools/             # One file per MCP tool
└── policy/            # Model allowlist, sandbox, cwd whitelist
plugin/
├── .claude-plugin/plugin.json
├── skills/cursor-subagent/SKILL.md
├── commands/cursor-login.md
└── hooks/on-user-prompt.mjs
tests/
```

---

## Known limitations

- **Session linking is loose.** Claude Code doesn't expose a shared session id to child MCP servers, so runs stamped with the MCP server's random UUID rarely match the session id Claude Code injects into the hook. The hook falls back to reporting these as `[unlinked]` so nothing is missed — noisy if you run concurrent Claude sessions.
- **True mid-silence wake-up isn't possible.** MCP notifications reach the client but Claude Code doesn't (currently) auto-invoke the model on them. Subagent completions surface on your **next** prompt, not asynchronously.
- **`spawn_subagent` requires a working cursor-agent + auth.** No queueing, no retry. If cursor-agent isn't installed or not authenticated, the tool call fails with a clear message pointing at `/cursor-login`.

---

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) — free for personal, research, educational, hobbyist, and other noncommercial use (including noncommercial open-source projects, charities, and government/academic institutions). **Commercial use, hosting-as-a-service, and repackaging for resale are not permitted.** If you want to use this in a for-profit setting, open an issue to discuss a commercial license.

Note: "noncommercial" here does not meet the OSI's Open Source Definition (which forbids field-of-use restrictions); this is a source-available license.
