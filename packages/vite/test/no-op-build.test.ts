import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tracr } from "../src/index.js";
import type { SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

/**
 * A tracer reaching a production bundle is an incident. HANDOFF calls this out
 * as a hazard to verify in CI rather than by inspection, so this drives a real
 * `vite build` and reads the emitted chunks.
 */

const SOURCES: SourceSpec[] = [{ id: "input.value", module: "*", path: "event.target.value" }];
const SINKS: SinkSpec[] = [{ id: "fetch.body", module: "*", path: "fetch", args: [1] }];

/** Everything the transform emits, all of which the dev path really produces. */
const EMITTED = [
  "__tracr",
  "installWebAgent",
  "registerSites",
  "registerSources",
  "takeReturn",
  "argTaint",
];

/**
 * Anything from tracr that must never appear in a shipped chunk. The bare
 * runtime specifier is forbidden but not emitted in dev, where the boot import
 * is an `/@fs/` absolute path instead.
 */
const FORBIDDEN = [...EMITTED, "@pablo_clueless/runtime"];

let dir = "";

const bundleChunks = async (): Promise<string[]> => {
  const assets = join(dir, "dist", "assets");
  const names = await readdir(assets);
  const scripts = names.filter((name) => name.endsWith(".js"));
  expect(scripts.length).toBeGreaterThan(0);
  return Promise.all(scripts.map((name) => readFile(join(assets, name), "utf8")));
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tracr-build-"));
  await mkdir(join(dir, "src"), { recursive: true });

  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>`,
    "utf8",
  );

  // Declares both a source and a sink, so an active transform would leave
  // unmistakable traces in the output.
  await writeFile(
    join(dir, "src", "main.js"),
    `const send = (event) => fetch("/x", event.target.value);
     document.getElementById("app").addEventListener("input", send);
     export default send;\n`,
    "utf8",
  );

  const { build } = await import("vite");
  await build({
    root: dir,
    logLevel: "silent",
    configFile: false,
    plugins: [tracr({ sources: SOURCES, sinks: SINKS })],
    build: { outDir: join(dir, "dist"), emptyOutDir: true, minify: false },
  });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("no-op build path", () => {
  it("leaves zero tracr bytes in a production bundle", async () => {
    const chunks = await bundleChunks();

    for (const code of chunks) {
      for (const marker of FORBIDDEN) {
        expect(code).not.toContain(marker);
      }
    }
  });

  it("still emits the application's own code", async () => {
    const chunks = await bundleChunks();
    expect(chunks.some((code) => code.includes("addEventListener"))).toBe(true);
  });

  it("returns no plugin at all when explicitly disabled", () => {
    expect(tracr({ enabled: false })).toBeNull();
  });

  /**
   * Guards the assertion above. "No markers found" only means something if the
   * same markers do appear when the transform actually runs, so this drives the
   * serve-mode path over the identical source.
   */
  it("emits those markers on the dev path, so their absence is meaningful", async () => {
    const plugin = tracr({ sources: SOURCES, sinks: SINKS });
    if (plugin === null) throw new Error("plugin was disabled");
    await plugin.configResolved({ root: dir });

    const source = await readFile(join(dir, "src", "main.js"), "utf8");
    const result = await plugin.transform(source, join(dir, "src", "main.js"));

    expect(result).not.toBeNull();
    for (const marker of EMITTED) {
      expect(result?.code).toContain(marker);
    }
    // The boot import still points at the runtime, just by absolute path.
    expect(result?.code).toMatch(/from "\/@fs\/.*runtime/);
  });
});
