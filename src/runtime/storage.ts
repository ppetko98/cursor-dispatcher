import { promises as fs } from "node:fs";
import { createWriteStream, WriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import type { RunMeta, StoredEvent, StoredMessage } from "../types.js";

const ROOT_ENV = "CURSOR_HARNESS_HOME";

export function harnessRoot(): string {
  return process.env[ROOT_ENV] ?? path.join(os.homedir(), ".claude-cursor-harness");
}

export function runDir(runId: string): string {
  return path.join(harnessRoot(), "runs", runId);
}

export function artifactsDir(runId: string): string {
  return path.join(runDir(runId), "artifacts");
}

export async function ensureRunDir(runId: string): Promise<void> {
  await fs.mkdir(artifactsDir(runId), { recursive: true });
}

export async function writeMeta(meta: RunMeta): Promise<void> {
  const dir = runDir(meta.runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "meta.json");
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readMeta(runId: string): Promise<RunMeta | null> {
  try {
    const raw = await fs.readFile(path.join(runDir(runId), "meta.json"), "utf8");
    return JSON.parse(raw) as RunMeta;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listRunIds(): Promise<string[]> {
  const dir = path.join(harnessRoot(), "runs");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function eventsPath(runId: string): string {
  return path.join(runDir(runId), "events.ndjson");
}

export function eventsGzPath(runId: string): string {
  return `${eventsPath(runId)}.gz`;
}

export function messagesPath(runId: string): string {
  return path.join(runDir(runId), "messages.ndjson");
}

export function messagesGzPath(runId: string): string {
  return `${messagesPath(runId)}.gz`;
}

export function openEventsAppendStream(runId: string): WriteStream {
  return createWriteStream(eventsPath(runId), { flags: "a" });
}

async function readTextOrGz(plain: string, gz: string): Promise<string | null> {
  try {
    return await fs.readFile(plain, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    const buf = await fs.readFile(gz);
    return gunzipSync(buf).toString("utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readEvents(
  runId: string,
  sinceEventId = 0,
  limit = 200,
): Promise<StoredEvent[]> {
  const raw = await readTextOrGz(eventsPath(runId), eventsGzPath(runId));
  if (raw === null) return [];
  const out: StoredEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: StoredEvent;
    try {
      parsed = JSON.parse(line) as StoredEvent;
    } catch {
      continue;
    }
    if (parsed.eventId > sinceEventId) out.push(parsed);
    if (out.length >= limit) break;
  }
  return out;
}

export async function appendMessage(msg: StoredMessage): Promise<void> {
  await fs.mkdir(runDir(msg.runId), { recursive: true });
  await fs.appendFile(messagesPath(msg.runId), JSON.stringify(msg) + "\n", "utf8");
}

// Gzips a file in place: writes <file>.gz then removes <file>. No-ops if the source
// file doesn't exist (already compressed or never written).
export async function gzipFileInPlace(file: string): Promise<boolean> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const gz = gzipSync(buf);
  const tmp = `${file}.gz.tmp`;
  await fs.writeFile(tmp, gz);
  await fs.rename(tmp, `${file}.gz`);
  await fs.rm(file, { force: true });
  return true;
}

export async function deleteRunDir(runId: string): Promise<void> {
  await fs.rm(runDir(runId), { recursive: true, force: true });
}
