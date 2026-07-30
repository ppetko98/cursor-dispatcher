import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCursorAuth, resetAuthCacheForTests } from "../src/runtime/auth.js";
import { resetConfigCache } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OK = path.resolve(HERE, "fixtures/fake-cursor-status-ok.mjs");
const NO = path.resolve(HERE, "fixtures/fake-cursor-status-nologin.mjs");

const originalBin = process.env["CURSOR_HARNESS_BIN"];
const originalKey = process.env["CURSOR_API_KEY"];

function setBin(p: string): void {
  process.env["CURSOR_HARNESS_BIN"] = p;
  resetConfigCache();
  resetAuthCacheForTests();
}

function clearEnv(): void {
  delete process.env["CURSOR_API_KEY"];
  if (originalBin === undefined) delete process.env["CURSOR_HARNESS_BIN"];
  else process.env["CURSOR_HARNESS_BIN"] = originalBin;
  resetConfigCache();
  resetAuthCacheForTests();
}

describe("checkCursorAuth", () => {
  beforeEach(() => {
    delete process.env["CURSOR_API_KEY"];
    resetAuthCacheForTests();
    resetConfigCache();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = originalKey;
    clearEnv();
  });

  it("detects a logged-in cursor-agent", async () => {
    setBin(OK);
    const state = await checkCursorAuth({ force: true });
    expect(state.authenticated).toBe(true);
    expect(state.method).toBe("login");
    expect(state.user).toBe("test@example.com");
  });

  it("flags a not-logged-in cursor-agent with the CLI reason", async () => {
    setBin(NO);
    const state = await checkCursorAuth({ force: true });
    expect(state.authenticated).toBe(false);
    expect(state.reason).toMatch(/Not logged in/i);
  });

  it("short-circuits to authenticated when CURSOR_API_KEY is set", async () => {
    process.env["CURSOR_API_KEY"] = "sk_test_xyz";
    setBin(NO); // would otherwise fail
    const state = await checkCursorAuth({ force: true });
    expect(state.authenticated).toBe(true);
    expect(state.method).toBe("api_key");
  });

  it("reports missing binary cleanly", async () => {
    setBin("/nonexistent/cursor-agent-does-not-exist");
    const state = await checkCursorAuth({ force: true });
    expect(state.authenticated).toBe(false);
    expect(state.reason).toMatch(/not found|failed to start|ENOENT/i);
  });

  it("caches results within the TTL", async () => {
    setBin(OK);
    const a = await checkCursorAuth({ force: true });
    // Point at a broken bin WITHOUT touching the auth cache; unforced call should
    // return the previous authenticated state.
    process.env["CURSOR_HARNESS_BIN"] = NO;
    resetConfigCache();
    const b = await checkCursorAuth();
    expect(b.authenticated).toBe(a.authenticated);
    expect(b.checkedAt).toBe(a.checkedAt);
  });
});
