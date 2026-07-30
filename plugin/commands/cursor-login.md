---
description: Authenticate the local cursor-agent CLI so cursor-harness can spawn subagents.
---

The user invoked `/cursor-login`. Do this:

1. First run `cursor-agent status` via the Bash tool to check whether they're already logged in. If it reports `Logged in as <email>`, tell the user they're already authenticated and stop.

2. Otherwise, explain that cursor-agent's login flow opens a browser and requires an interactive terminal. Give them two options:

   - **Interactive login (recommended)** — they should run this themselves in their own terminal:
     ```
     cursor-agent login
     ```
     It opens a browser tab where they sign into Cursor and grant CLI access.

   - **API key (headless)** — get an API key from https://cursor.com/settings and set:
     ```
     export CURSOR_API_KEY=<key>
     ```
     in the shell that will start Claude Code (or add it to their shell rc). Then restart Claude Code so the MCP server picks up the env var.

3. After they've done one of the two, remind them to toggle `cursor-harness` off/on in `/mcp` (or restart Claude Code) so the auth-status cache in the MCP server refreshes, then they can call `spawn_subagent` again.

Do NOT try to run `cursor-agent login` via Bash yourself — it needs a real TTY and browser and will hang or fail if you invoke it in a non-interactive shell.
