import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { assertModelAllowed, allowedModels } from "../src/policy/models.js";
import { resolveAndValidateCwd } from "../src/policy/sandbox.js";
import { resetConfigCache } from "../src/config.js";

describe("model allowlist", () => {
  const original = process.env["CURSOR_HARNESS_MODELS"];
  afterEach(() => {
    if (original === undefined) delete process.env["CURSOR_HARNESS_MODELS"];
    else process.env["CURSOR_HARNESS_MODELS"] = original;
    resetConfigCache();
  });

  it("respects env override", async () => {
    process.env["CURSOR_HARNESS_MODELS"] = "foo,bar";
    resetConfigCache();
    expect(await allowedModels()).toEqual(["foo", "bar"]);
    await expect(assertModelAllowed("bar")).resolves.toBeUndefined();
    await expect(assertModelAllowed("baz")).rejects.toThrow(/not in allowlist/);
  });
});

describe("cwd validation", () => {
  let tmp: string;
  const originalRoot = process.env["CURSOR_HARNESS_CWD_ROOT"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-cwd-"));
    process.env["CURSOR_HARNESS_CWD_ROOT"] = tmp;
    resetConfigCache();
  });
  afterEach(async () => {
    if (originalRoot === undefined) delete process.env["CURSOR_HARNESS_CWD_ROOT"];
    else process.env["CURSOR_HARNESS_CWD_ROOT"] = originalRoot;
    resetConfigCache();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("accepts cwd inside the root", async () => {
    const inside = path.join(tmp, "proj");
    await fs.mkdir(inside);
    const resolved = await resolveAndValidateCwd(inside);
    expect(resolved).toBe(path.resolve(inside));
  });

  it("rejects cwd outside the root", async () => {
    const outside = path.resolve(tmp, "..");
    await expect(resolveAndValidateCwd(outside)).rejects.toThrow(/outside allowed root/);
  });

  it("rejects non-existent cwd", async () => {
    await expect(resolveAndValidateCwd(path.join(tmp, "nope"))).rejects.toThrow(/does not exist/);
  });
});
