import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

let server: Server | undefined;

export function bindServer(s: Server): void {
  server = s;
}

export function notifyResourceUpdated(uri: string): void {
  if (!server) return;
  void server
    .notification({ method: "notifications/resources/updated", params: { uri } })
    .catch(() => {});
}

export function notifyMessage(
  level: "debug" | "info" | "warning" | "error",
  runId: string,
  text: string,
): void {
  if (!server) return;
  void server
    .notification({
      method: "notifications/message",
      params: { level, logger: `cursor-dispatcher:${runId}`, data: text },
    })
    .catch(() => {});
}
