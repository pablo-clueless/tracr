import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { tracr, type TracrViteOptions } from "../src/index.js";
import type { SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

const ROOT = process.platform === "win32" ? "C:\\app" : "/app";

const SOURCES: SourceSpec[] = [{ id: "vue.input", module: "*", path: "event.target.value" }];
const SINKS: SinkSpec[] = [{ id: "fetch.body", module: "*", path: "fetch", args: [1] }];

const HANDLER = "export const send = (event) => fetch('/x', event.target.value);";

type Plugin = NonNullable<ReturnType<typeof tracr>>;

const make = (options: TracrViteOptions = {}): Plugin => {
  const plugin = tracr({ sources: SOURCES, sinks: SINKS, ...options });
  if (plugin === null) throw new Error("plugin was disabled");
  plugin.configResolved({ root: ROOT });
  return plugin;
};

const transform = (plugin: Plugin, relative: string, code = HANDLER) =>
  plugin.transform(code, join(ROOT, relative));

describe("vite plugin", () => {
  let plugin: Plugin;

  beforeEach(() => {
    plugin = make();
  });

  it("returns null when disabled so a build sees no plugin at all", () => {
    expect(tracr({ enabled: false })).toBeNull();
  });

  it("only ever attaches to the dev server", () => {
    expect(plugin.apply).toBe("serve");
    expect(plugin.enforce).toBe("post");
  });

  it("injects the browser agent and instruments", async () => {
    const result = await transform(plugin, "src/App.js");

    expect(result).not.toBeNull();
    expect(result?.code).toContain("installWebAgent");
    expect(result?.code).toContain("registerSources(");
    expect(result?.code).toContain("registerSites(");
  });

  it("passes the daemon url and debug flag to the agent", async () => {
    const configured = make({ url: "ws://localhost:7331", debug: true });
    const result = await transform(configured, "src/App.js");

    expect(result?.code).toContain('"url":"ws://localhost:7331"');
    expect(result?.code).toContain('"debug":true');
  });

  it("boots from an /@fs url so a workspace runtime resolves", async () => {
    const result = await transform(plugin, "src/App.js");
    expect(result?.code).toMatch(/from "\/@fs\//);
  });

  it("appends the runtime directory to the fs guard without clobbering it", () => {
    const config = { root: ROOT, server: { fs: { allow: [ROOT] } } };
    const fresh = tracr({ sources: SOURCES, sinks: SINKS })!;
    void fresh.configResolved(config);
    expect(config.server.fs.allow[0]).toBe(ROOT);
    expect(config.server.fs.allow).toHaveLength(2);
  });

  it("keeps the runtime out of dep pre-bundling", () => {
    const config = plugin.config() as { optimizeDeps: { exclude: string[] } };
    expect(config.optimizeDeps.exclude).toContain("@pablo_clueless/runtime");
  });

  it("registers source names exactly once per dev server", async () => {
    const first = await transform(plugin, "src/a.js");
    const second = await transform(plugin, "src/b.js");

    expect(first?.code).toContain("registerSources(");
    expect(second?.code).not.toContain("registerSources(");
  });

  it("offsets site IDs so they stay unique across modules", async () => {
    const idsOf = (code: string): number[] => {
      const match = code.match(/registerSites\((\{.*?\})\);\n/s);
      if (match === null) return [];
      return (JSON.parse(match[1] as string) as { sites: { siteId: number }[] }).sites.map(
        (site) => site.siteId,
      );
    };

    const first = await transform(plugin, "src/a.js");
    const second = await transform(plugin, "src/b.js");

    const a = idsOf(first?.code ?? "");
    const b = idsOf(second?.code ?? "");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(Math.min(...b)).toBe(Math.max(...a) + 1);
  });

  it("skips virtual modules", async () => {
    expect(await plugin.transform(HANDLER, "\0virtual:thing")).toBeNull();
  });

  it("skips node_modules", async () => {
    expect(await transform(plugin, "node_modules/pkg/index.js")).toBeNull();
  });

  it("instruments a compiled vue SFC", async () => {
    // enforce: post means plugin-vue already turned the SFC into JavaScript,
    // even though the id still ends in .vue.
    const result = await transform(plugin, "src/App.vue");
    expect(result?.code).toContain("installWebAgent");
  });

  it.each(["type=style", "type=template", "type=custom"])(
    "skips the %s block of an SFC",
    async (block) => {
      const id = join(ROOT, "src/App.vue") + "?vue&" + block + "&lang.css";
      expect(await plugin.transform(HANDLER, id)).toBeNull();
    },
  );

  it("skips non-script assets", async () => {
    expect(await transform(plugin, "src/styles.css")).toBeNull();
  });

  it("tolerates a query string on the id", async () => {
    const result = await plugin.transform(HANDLER, `${join(ROOT, "src/App.js")}?v=abc123`);
    expect(result?.code).toContain("installWebAgent");
  });

  it("leaves modules outside the vite root alone", async () => {
    const outside = process.platform === "win32" ? "C:\\elsewhere\\x.js" : "/elsewhere/x.js";
    expect(await plugin.transform(HANDLER, outside)).toBeNull();
  });

  it("honours include and exclude", async () => {
    const scoped = make({ include: ["src/**/*.js"], exclude: ["src/generated/**"] });

    expect(await transform(scoped, "src/App.js")).not.toBeNull();
    expect(await transform(scoped, "src/generated/api.js")).toBeNull();
    expect(await transform(scoped, "scripts/build.js")).toBeNull();
  });

  it("ships nothing when the transform fails", async () => {
    expect(await transform(plugin, "src/broken.js", "const (((")).toBeNull();
  });

  it("emits a source map", async () => {
    const result = await transform(plugin, "src/App.js");
    expect(result?.map).toBeTruthy();
  });
});
