#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSubagent } from "./tools/spawn.js";
import { sendSubagentMessage } from "./tools/message.js";
import { getSubagentStatus } from "./tools/status.js";
import { getSubagentEvents } from "./tools/events.js";
import { listSubagents } from "./tools/list.js";
import { cancelSubagent } from "./tools/cancel.js";
import { getSubagentResult } from "./tools/result.js";
import { registry } from "./runtime/registry.js";
import { bindServer } from "./runtime/notifier.js";
import { readEvents } from "./runtime/storage.js";
import { allowedModels } from "./policy/models.js";
import { loadConfig } from "./config.js";
import { pruneSubagents } from "./tools/prune.js";
import { checkCursorAuth } from "./runtime/auth.js";
import { notifyMessage } from "./runtime/notifier.js";

async function buildTools(): Promise<unknown[]> {
  const models = await allowedModels();
  return [
  {
    name: "spawn_subagent",
    description:
      "Launch a Cursor subagent with the given prompt. Returns immediately with a run_id; the subagent runs asynchronously. Model must be in the allowlist. Use get_subagent_events or subscribe to subagent://<run_id>/events to observe progress.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Initial task prompt for the subagent." },
        model: {
          type: "string",
          description: `Model to use. Allowed: ${models.join(", ")}.`,
        },
        mode: {
          type: "string",
          enum: ["agent", "plan", "ask"],
          description: "Cursor mode. Defaults to 'agent'.",
        },
        permission: {
          type: "string",
          enum: ["read", "auto", "trust"],
          description:
            "Tool-approval posture. 'read' = read-only (forces --mode=ask if mode not set); 'auto' (default) = safe tools auto-approved via --auto-review + --trust; 'trust' = fully autonomous via --yolo + --trust. Choose based on the parent Claude session's own permission mode.",
        },
        cwd: {
          type: "string",
          description: "Working directory (must be under CURSOR_HARNESS_CWD_ROOT).",
        },
        sandbox: {
          type: "string",
          enum: ["enabled", "disabled"],
          description: "Sandbox mode. Defaults to 'enabled'.",
        },
        context_files: {
          type: "array",
          items: { type: "string" },
          description: "File paths to reference in the prompt.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Per-turn timeout in milliseconds.",
        },
      },
    },
  },
  {
    name: "send_subagent_message",
    description:
      "Send a follow-up message to a running subagent (resumes the same chat). Errors if a turn is already in flight.",
    inputSchema: {
      type: "object",
      required: ["run_id", "message"],
      properties: {
        run_id: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  {
    name: "get_subagent_status",
    description: "Return the current status of a subagent run.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "get_subagent_events",
    description:
      "Fetch NDJSON events emitted by a subagent since a given event id. Use for polling or to catch up after a notifications/resources/updated ping.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
        since_event_id: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "list_subagents",
    description: "List subagent runs known to this harness.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [
            "created",
            "running",
            "waiting_on_parent",
            "waiting_on_user",
            "completed",
            "failed",
            "cancelled",
            "timed_out",
          ],
        },
        since: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "cancel_subagent",
    description: "Terminate a running subagent (SIGTERM).",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "get_subagent_result",
    description:
      "Return the final structured completion payload for a terminated run (status ∈ {completed, failed, cancelled, timed_out}).",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "prune_subagents",
    description:
      "Compress / delete old terminal runs. By default follows the retention config (compress after N days, delete after M days, LRU cap). Pass overrides to run a manual cleanup or set dry_run=true to preview what would happen.",
    inputSchema: {
      type: "object",
      properties: {
        compress_after_days: { type: "number", minimum: 0 },
        max_age_days: { type: "number", minimum: 0 },
        keep_last: { type: "integer", minimum: 0 },
        dry_run: { type: "boolean" },
      },
    },
  },
  ];
}

let TOOLS: unknown[] = [];

async function main(): Promise<void> {
  const server = new Server(
    { name: "cursor-harness", version: "0.1.0" },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true }, logging: {} } },
  );
  bindServer(server);
  await loadConfig();
  TOOLS = await buildTools();
  await registry.load();

  // Preflight auth check so operators see the state in the MCP log immediately.
  // Non-fatal: spawn_subagent re-checks and returns an actionable error itself.
  void checkCursorAuth()
    .then((state) => {
      if (state.authenticated) {
        const who = state.user ? ` as ${state.user}` : "";
        notifyMessage("info", "startup", `cursor-agent authenticated${who} (${state.method})`);
      } else {
        notifyMessage(
          "warning",
          "startup",
          `cursor-agent NOT authenticated: ${state.reason ?? "unknown"}. Run /cursor-login or 'cursor-agent login'.`,
        );
      }
    })
    .catch(() => {});

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = await dispatch(name, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => {
    const resources: Array<{ uri: string; name: string; mimeType: string }> = [];
    for (const meta of registry.list()) {
      resources.push({
        uri: `subagent://${meta.runId}/status`,
        name: `Run ${meta.runId} status`,
        mimeType: "application/json",
      });
      resources.push({
        uri: `subagent://${meta.runId}/events`,
        name: `Run ${meta.runId} events`,
        mimeType: "application/x-ndjson",
      });
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const match = uri.match(/^subagent:\/\/([^/]+)\/(status|events)$/);
    if (!match) throw new Error(`unknown resource: ${uri}`);
    const runId = match[1]!;
    const kind = match[2]!;
    if (kind === "status") {
      const meta = registry.getMeta(runId);
      if (!meta) throw new Error(`unknown run ${runId}`);
      return {
        contents: [
          { uri, mimeType: "application/json", text: JSON.stringify(meta, null, 2) },
        ],
      };
    }
    const events = await readEvents(runId, 0, 10_000);
    return {
      contents: [
        {
          uri,
          mimeType: "application/x-ndjson",
          text: events.map((e) => JSON.stringify(e)).join("\n"),
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "spawn_subagent":
      return spawnSubagent(args);
    case "send_subagent_message":
      return sendSubagentMessage(args);
    case "get_subagent_status":
      return getSubagentStatus(args);
    case "get_subagent_events":
      return getSubagentEvents(args);
    case "list_subagents":
      return listSubagents(args);
    case "cancel_subagent":
      return cancelSubagent(args);
    case "get_subagent_result":
      return getSubagentResult(args);
    case "prune_subagents":
      return pruneSubagents(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
