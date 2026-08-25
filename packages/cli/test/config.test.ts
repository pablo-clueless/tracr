import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, resolveSocketPath } from "../src/config.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tracr-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("falls back to the defaults when no config exists", async () => {
    const config = await loadConfig(dir);
    expect(config.sources).toEqual([]);
    expect(config.sinks).toEqual([]);
  });

  it("reads a plain .mjs config", async () => {
    await writeFile(
      join(dir, "tracr.config.mjs"),
      `export default {
         sources: [{ id: "express.body", module: "express", path: "req.body" }],
         sinks: [{ id: "db.query", module: "*", path: "query", args: [0] }],
       };\n`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.sources.map((s) => s.id)).toEqual(["express.body"]);
    expect(config.sinks.map((s) => s.id)).toEqual(["db.query"]);
    // Unspecified keys still come from the defaults.
    expect(config.uiPort).toBe(7331);
  });

  it("strips types from a .ts config", async () => {
    await writeFile(
      join(dir, "tracr.config.ts"),
      `interface Spec { id: string; module: string; path: string }
       const sources: Spec[] = [{ id: "typed.source", module: "*", path: "req.body" }];
       export default { sources, sinks: [] as Spec[] };\n`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.sources.map((s) => s.id)).toEqual(["typed.source"]);
  });

  it("leaves no scratch file behind after transpiling", async () => {
    await writeFile(
      join(dir, "tracr.config.ts"),
      `export default { sources: [] as { id: string }[] };\n`,
      "utf8",
    );
    await loadConfig(dir);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["tracr.config.ts"]);
  });

  it("folds adapter sources and sinks in ahead of the project's own", async () => {
    await writeFile(
      join(dir, "adapter.mjs"),
      `export default {
         name: "fake",
         sources: [{ id: "adapter.source", module: "*", path: "event.target.value" }],
         sinks: [{ id: "fetch.body", module: "*", path: "fetch", args: [1] }],
       };\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "tracr.config.mjs"),
      `export default {
         adapters: ["./adapter.mjs"],
         sources: [{ id: "own.source", module: "*", path: "req.body" }],
       };\n`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.sources.map((s) => s.id)).toEqual(["adapter.source", "own.source"]);
    expect(config.sinks.map((s) => s.id)).toEqual(["fetch.body"]);
  });

  it("lets the project override an adapter spec of the same id", async () => {
    await writeFile(
      join(dir, "adapter.mjs"),
      `export default {
         name: "fake",
         sources: [{ id: "shared", module: "*", path: "from.adapter" }],
         sinks: [],
       };\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "tracr.config.mjs"),
      `export default {
         adapters: ["./adapter.mjs"],
         sources: [{ id: "shared", module: "*", path: "from.project" }],
       };\n`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0]?.path).toBe("from.project");
  });

  it("survives a config that throws", async () => {
    await writeFile(join(dir, "tracr.config.mjs"), `throw new Error("boom");\n`, "utf8");
    const config = await loadConfig(dir);
    expect(config.sources).toEqual([]);
  });
});

describe("resolveSocketPath", () => {
  it("produces a per-project path", () => {
    const a = resolveSocketPath("/one", ".tracr/daemon.sock");
    const b = resolveSocketPath("/two", ".tracr/daemon.sock");
    expect(a).not.toBe(b);
  });

  it("uses a named pipe on windows and an absolute path elsewhere", () => {
    const resolved = resolveSocketPath(process.cwd(), ".tracr/daemon.sock");
    if (process.platform === "win32") {
      expect(resolved.startsWith("\\\\.\\pipe\\tracr-")).toBe(true);
    } else {
      expect(resolved.endsWith("/.tracr/daemon.sock")).toBe(true);
    }
  });
});
