---
name: cursor-subagent
description: Delegate a bounded coding task to a Cursor subagent via the cursor-harness MCP server without blocking the chat.
---

# Cursor Subagent

Use this to hand a scoped implementation task to a Cursor subagent while you continue talking with the user. The subagent runs asynchronously; you do NOT wait for it.

## When to reach for it

- The user asks you to delegate work ("have cursor do this", "spin up a subagent").
- You want a Cursor session to make edits in parallel while you handle the conversation, planning, or a different file.
- The task is bounded (single feature, single fix, single script) and has a clear "done."

Don't use it for tasks better done in your own turn (small edits, questions, planning conversations).

## The non-blocking loop

**Do this:**

1. Call `spawn_subagent({ prompt, cwd, permission })`. It returns **immediately** with a `run_id`.
2. Tell the user briefly: "Spawned cursor subagent `<run_id>` — I'll check in when it's done or you ask."
3. **Move on.** Answer the user's next question. Work on a different file. Do NOT loop `get_subagent_status` or `get_subagent_events`.
4. On any subsequent turn, scan the MCP notifications/log for a line matching `SUBAGENT <run_id> → completed|failed|cancelled — <summary>`. That line carries the answer inline — call `get_subagent_result` only if the user wants the full artifacts list.
5. If the user asks about progress mid-run, call `get_subagent_status` **once** (not in a loop) and report.

**Don't do this:**

- Poll `get_subagent_events` or `get_subagent_status` in a tight sequence after spawn. You'll burn tool calls and stall the chat. The terminal event is pushed via `notifications/message`; you'll see it next time you're invoked.
- Block your turn trying to "wait" for the subagent. Return to the user; they will re-invoke you naturally (a follow-up message, `/loop`, etc.).

## Choosing `permission`

Map the parent session's own posture:

| Parent Claude is in… | Pass |
|---|---|
| plan / read-only mode | `"read"` — subagent runs `--mode ask` (no writes) |
| default / accept-edits | `"auto"` — safe tools auto, others prompt (`--auto-review --trust`) |
| user explicitly said "let it rip" / hands-off | `"trust"` — full autonomy (`--yolo --trust`) |

Default: `"auto"`. Never escalate to `"trust"` on your own — that's a decision the user makes.

## Choosing `cwd`

Must be under the harness's configured root (default `~/workspace`). If unsure, omit it and it defaults to that root. Never pass paths outside — the harness will reject them.

## Follow-ups within a run

- `send_subagent_message({ run_id, message })` — resumes the same Cursor chat (uses `--resume=<chat_id>`). Errors if a turn is currently in flight; wait for the previous terminal notification first.
- `cancel_subagent({ run_id })` — SIGTERM the child. Use when the user changes their mind or the run has clearly gone off the rails.

## Housekeeping

- `list_subagents({ status: "running" })` — sanity check on outstanding work.
- `prune_subagents({ dry_run: true })` — see the retention plan (compress ≥7d, delete ≥14d, LRU cap 200). Then call without `dry_run` to execute if needed.

## Example flow

User: "Have cursor scaffold a fastify server at ~/workspace/api/ and I'll ask you about auth in the meantime."

You:
1. `spawn_subagent({ prompt: "Scaffold a fastify server with /health and /ping routes at ~/workspace/api/. Include package.json and a smoke test.", cwd: "/Users/…/workspace/api", permission: "auto" })` → `run_id=abc123`
2. "Spawned cursor subagent `abc123` on the fastify scaffold. What's the auth question?"
3. Answer the auth question fully.
4. Next turn: notice `SUBAGENT abc123 → completed — Created …` in the log. "Cursor finished the scaffold. It added `api/server.js` with /health and /ping and a smoke test — want me to pull the full artifact list?"
