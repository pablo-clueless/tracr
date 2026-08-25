import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialize, load, type LoadResult } from "../src/loader.js";
import type { SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

/** A root the filter can produce real relative paths against on either platform. */
const ROOT = process.platform === "win32" ? "C:\\app" : "/app";

const urlFor = (relative: string): string => pathToFileURL(join(ROOT, relative)).href;

const run = async (relative: string, code: string, format = "module") => {
  const result = await load(urlFor(relative), { format }, async (_url, context) => ({
    format: context.format ?? "module",
    source: code,
  }));
  return result as LoadResult & { source: string };
};

const SOURCES: SourceSpec[] = [{ id: "s", module: "*", path: "req.body" }];
const SINKS: SinkSpec[] = [{ id: "db.query", module: "*", path: "query", args: [0] }];

const HANDLER = "export const h = (req) => query(req.body.name);";

const setup = (overrides: Parameters<typeof initialize>[0] = {}) =>
  initialize({
    socket: null,
    root: ROOT,
    include: [],
    exclude: ["**/node_modules/**"],
    sources: SOURCES,
    sinks: SINKS,
    ...overrides,
  });

describe("cli loader", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TRACR_SOCKET;
    delete process.env.TRACR_ENABLE;
    setup({ sources: [], sinks: [] });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("is a byte-identical pass-through when not enabled", async () => {
    const code = "const x = req.body.name;";
    const result = await run("src/server.js", code);
    expect(result.source).toBe(code);
  });

  it("injects the bootstrap and instruments when enabled", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();

    const result = await run("src/server.js", HANDLER);

    expect(result.source).toContain("installNodeAgent");
    expect(result.source).toContain("registerSources(");
    expect(result.source).toMatch(/\$name\$t\b|registerSites\(/);
  });

  it("offsets site IDs so they stay unique across files", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();

    const first = await run("src/a.js", HANDLER);
    const second = await run("src/b.js", HANDLER);

    const idsOf = (out: string): number[] => {
      const match = out.match(/registerSites\((\{.*?\})\);\n/s);
      if (match === null) return [];
      return (JSON.parse(match[1] as string) as { sites: { siteId: number }[] }).sites.map(
        (site) => site.siteId,
      );
    };

    const a = idsOf(first.source);
    const b = idsOf(second.source);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(Math.min(...b)).toBe(Math.max(...a) + 1);
  });

  it("registers source names exactly once per process", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();

    const first = await run("src/first.js", HANDLER);
    const second = await run("src/second.js", HANDLER);

    expect(first.source).toContain("registerSources(");
    expect(second.source).not.toContain("registerSources(");
  });

  it("never touches node_modules", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();
    const code = "const x = req.body.name;";
    const result = await run("node_modules/pkg/index.js", code);
    expect(result.source).toBe(code);
  });

  it("leaves files outside the project root alone", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();

    // A workspace symlink resolves tracr's own packages to a real path outside
    // node_modules; instrumenting them builds an import cycle into the runtime.
    const outside = pathToFileURL(
      process.platform === "win32" ? "C:\\elsewhere\\runtime.js" : "/elsewhere/runtime.js",
    ).href;

    const code = "const x = req.body.name;";
    const result = (await load(outside, { format: "module" }, async () => ({
      format: "module",
      source: code,
    }))) as LoadResult & { source: string };

    expect(result.source).toBe(code);
  });

  it("honours the exclude patterns", async () => {
    process.env.TRACR_ENABLE = "1";
    setup({ exclude: ["**/node_modules/**", "src/generated/**"] });

    const result = await run("src/generated/schema.js", HANDLER);
    expect(result.source).toBe(HANDLER);
  });

  it("honours the include patterns", async () => {
    process.env.TRACR_ENABLE = "1";
    setup({ include: ["src/**/*.{js,ts}"] });

    const inside = await run("src/server.js", HANDLER);
    const outside = await run("scripts/build.js", HANDLER);

    expect(inside.source).toContain("installNodeAgent");
    expect(outside.source).toBe(HANDLER);
  });

  it("ships the original when the transform fails", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();
    const broken = "const (((";
    const result = await run("src/broken.js", broken);
    expect(result.source).toBe(broken);
  });

  it("uses a require-based bootstrap for commonjs", async () => {
    process.env.TRACR_ENABLE = "1";
    setup();

    const result = await run(
      "src/server.cjs",
      "module.exports = (req) => query(req.body.name);",
      "commonjs",
    );
    expect(result.source).toContain("require(");
    expect(result.source).not.toContain("import ");
  });
});
