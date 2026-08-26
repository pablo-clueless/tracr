import { createRequire } from "node:module";
import { dirname, isAbsolute, relative } from "node:path";

import { transformAsync, type TransformOptions } from "@babel/core";
import {
  createFilter,
  resolveOptions,
  tracrBabelPlugin,
  type TracrPluginOptions,
} from "@pablo_clueless/babel-plugin";
import type { SiteTable } from "@pablo_clueless/protocol";
import { loadConfig } from "@pablo_clueless/tracr";

const BOOT = "__tracr_boot__";

/**
 * `.vue` and `.svelte` are here because `enforce: 'post'` means the framework
 * plugin has already compiled the SFC to JavaScript — the id keeps the original
 * extension, but the code arriving at `transform` is plain JS.
 */
const INSTRUMENTABLE = /\.[cm]?jsx?$|\.[cm]?tsx?$|\.vue$|\.svelte$/;

/**
 * Vite splits an SFC into blocks by query. Only the script block is code;
 * style blocks are CSS, and template attribution is out of scope for v1.
 */
const NON_SCRIPT_BLOCK = /[?&]type=(style|template|custom)\b/;

export interface TracrViteOptions extends Partial<TracrPluginOptions> {
  /** When false the plugin returns nothing, so a production build is untouched. */
  enabled?: boolean;
  /** WebSocket URL of the daemon. Without one the runtime still traces locally. */
  url?: string | null;
  /** Print each sink's derivation chain to the browser console. */
  debug?: boolean;
  include?: string[];
  exclude?: string[];
}

interface ViteConfigEnv {
  root?: string;
  server?: { fs?: { allow?: string[] } };
}

interface VitePluginShape {
  name: string;
  enforce: "post";
  apply: "serve";
  config(): Record<string, unknown>;
  configResolved(config: ViteConfigEnv): void | Promise<void>;
  transform(code: string, id: string): Promise<{ code: string; map: unknown } | null>;
}

const parserPlugins = (path: string): string[] => {
  if (/\.tsx$/.test(path)) return ["typescript", "jsx"];
  if (/\.[cm]?ts$/.test(path)) return ["typescript"];
  if (/\.jsx$/.test(path)) return ["jsx"];
  return [];
};

/**
 * Vite serves files outside the project root only through `/@fs/`. In a
 * workspace the runtime resolves outside root, so the boot import has to use
 * that form and the directory has to be added to `server.fs.allow`.
 */
const fsUrl = (absolute: string): string => {
  const posix = absolute.replace(/\\/g, "/");
  return `/@fs${posix.startsWith("/") ? "" : "/"}${posix}`;
};

/**
 * `enforce: 'post'` is load-bearing. Running before plugin-react / plugin-vue
 * means being handed raw JSX or an uncompiled SFC, which is syntax the transform
 * does not understand.
 *
 * `apply: 'serve'` is the no-op build path: a tracer reaching a production
 * bundle is an incident, so the plugin never attaches to a build at all.
 */
export const tracr = (options: TracrViteOptions = {}): VitePluginShape | null => {
  const { enabled = true, url = null, debug = false, include, exclude, ...pluginOptions } = options;

  if (!enabled) return null;

  let runtimeEntry: string | null = null;
  try {
    runtimeEntry = createRequire(import.meta.url).resolve("@pablo_clueless/runtime");
  } catch {
    // Runtime unresolvable: stay a pass-through rather than break the dev server.
  }
  if (runtimeEntry === null) return null;

  const bootFrom = fsUrl(runtimeEntry);

  let resolved = resolveOptions(pluginOptions);
  let filter = createFilter(include ?? [], exclude ?? ["**/node_modules/**", "**/dist/**"]);
  let root = process.cwd();
  let nextSiteBase = 0;
  let sourcesRegistered = false;

  return {
    name: "tracr",
    enforce: "post",
    apply: "serve",

    config() {
      return {
        // Pre-bundling would give each importer its own copy and break the
        // one-runtime-per-page invariant `install()` relies on.
        optimizeDeps: { exclude: ["@pablo_clueless/runtime"] },
      };
    },

    /**
     * The browser agent reads the same `tracr.config.ts` the Node agent does,
     * so sources and sinks are declared once per project. Anything passed to
     * `tracr()` directly still wins — an explicit argument beats a file.
     */
    async configResolved(config: ViteConfigEnv) {
      root = config.root ?? process.cwd();

      // Appended, not assigned: setting `server.fs.allow` from the `config`
      // hook replaces Vite's computed defaults and locks the app out of its
      // own source tree.
      config.server?.fs?.allow?.push(dirname(runtimeEntry));

      const project = await loadConfig(root).catch(() => null);
      if (project === null) return;

      resolved = resolveOptions({
        ...pluginOptions,
        sources: pluginOptions.sources ?? project.sources,
        sinks: pluginOptions.sinks ?? project.sinks,
        shims: pluginOptions.shims ?? project.shims,
      });
      filter = createFilter(include ?? project.include, exclude ?? project.exclude);
    },

    async transform(code: string, id: string) {
      // Virtual modules have no file behind them and no provenance to track.
      if (id.startsWith("\0")) return null;
      if (NON_SCRIPT_BLOCK.test(id)) return null;

      const cleanId = id.replace(/\?.*$/, "");
      if (!INSTRUMENTABLE.test(cleanId)) return null;
      if (/[/\\]node_modules[/\\]/.test(cleanId)) return null;
      if (!isAbsolute(cleanId)) return null;

      const rel = relative(root, cleanId);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
      if (!filter(rel)) return null;

      const siteBase = nextSiteBase;

      let transformed;
      try {
        transformed = await transformAsync(code, {
          filename: cleanId,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          parserOpts: {
            plugins: parserPlugins(cleanId) as NonNullable<
              TransformOptions["parserOpts"]
            >["plugins"],
          },
          plugins: [[tracrBabelPlugin, { ...resolved, siteIdBase: siteBase }]],
        });
      } catch {
        // A transform failure must not take the dev server down; ship the original.
        return null;
      }

      if (transformed?.code == null) return null;

      const table = (transformed.metadata as { tracr?: { siteTable?: SiteTable } } | undefined)
        ?.tracr?.siteTable;
      if (table !== undefined) nextSiteBase += table.sites.length;

      const boot = JSON.stringify({ url, debug });
      let prelude = `import { installWebAgent as ${BOOT} } from ${JSON.stringify(bootFrom)};\n${BOOT}(${boot});\n`;

      // Source names are page-wide, so the first instrumented module carries them.
      if (!sourcesRegistered) {
        sourcesRegistered = true;
        prelude += `globalThis.__tracr.registerSources(${JSON.stringify(resolved.sources)});\n`;
      }

      if (table !== undefined && table.sites.length > 0) {
        prelude += `globalThis.__tracr.registerSites(${JSON.stringify(table)});\n`;
      }

      return { code: prelude + transformed.code, map: transformed.map };
    },
  };
};

export default tracr;
