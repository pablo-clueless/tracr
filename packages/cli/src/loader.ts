import { createRequire } from "node:module";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transformAsync, type TransformOptions } from "@babel/core";
import {
  resolveOptions,
  tracrBabelPlugin,
  type TracrPluginOptions,
} from "@pablo_clueless/babel-plugin";
import type { SiteTable } from "@pablo_clueless/protocol";

import { createFilter, type PathFilter } from "./glob.js";

/**
 * Node module customization hooks. Registered via `module.register()`, which is
 * Node-only; browser code is instrumented by the bundler plugin instead.
 */
export interface LoadContext {
  format: string | null | undefined;
  importAttributes?: Record<string, string>;
}

export interface LoadResult {
  format: string;
  source: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
}

export type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

/** Structured-clonable payload `register()` hands to `initialize()`. */
export interface LoaderData extends Partial<TracrPluginOptions> {
  socket?: string | null;
  /** Project root the include/exclude patterns are relative to. */
  root?: string;
  include?: string[];
  exclude?: string[];
}

const BOOT = "__tracr_boot__";

const INSTRUMENTABLE = /\.[cm]?jsx?$|\.[cm]?tsx?$|\.jsx$/;

const parserPlugins = (path: string): string[] => {
  if (/\.tsx$/.test(path)) return ["typescript", "jsx"];
  if (/\.[cm]?ts$/.test(path)) return ["typescript"];
  if (/\.jsx$/.test(path)) return ["jsx"];
  return [];
};

let pluginData: LoaderData = {};
let runtimeUrl: string | null = null;
let nextSiteBase = 0;
let sourcesRegistered = false;
let filter: PathFilter = createFilter([], []);
let root = process.cwd();

try {
  runtimeUrl = pathToFileURL(createRequire(import.meta.url).resolve("@pablo_clueless/runtime"))
    .href;
} catch {
  // Runtime unresolvable: stay a pass-through rather than break the host.
}

/**
 * Instrumentation is opt-in. With neither a daemon socket nor an explicit
 * enable flag, the loader compiles to nothing and the disabled path stays
 * byte-identical to running without tracr.
 */
const enabled = (): boolean =>
  Boolean(process.env.TRACR_SOCKET) ||
  process.env.TRACR_ENABLE === "1" ||
  Boolean(pluginData.socket);

export const initialize = (data?: LoaderData): void => {
  if (data === undefined || Object.keys(data).length === 0) return;
  pluginData = data;
  root = data.root ?? process.cwd();
  filter = createFilter(data.include ?? [], data.exclude ?? []);
  // New specs mean the names already emitted are stale; re-emit on the next file.
  sourcesRegistered = false;
};

const bootLine = (format: string): string =>
  format === "commonjs"
    ? `var ${BOOT} = require(${JSON.stringify(fileURLToPath(runtimeUrl!))}).installNodeAgent();\n`
    : `import { installNodeAgent as ${BOOT} } from ${JSON.stringify(runtimeUrl)};\n${BOOT}();\n`;

/** Synthetic or malformed URLs (tests, data:) have no filesystem path. */
const toFilename = (url: string): string => {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
};

export const load = async (
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> => {
  const result = await nextLoad(url, context);

  if (!enabled()) return result;
  if (runtimeUrl === null) return result;

  const format = result.format ?? "";
  if (format !== "module" && format !== "commonjs" && !format.endsWith("-typescript")) {
    return result;
  }
  if (/[/\\]node_modules[/\\]/.test(url)) return result;

  const cleanUrl = url.replace(/\?.*$/, "");
  if (!INSTRUMENTABLE.test(cleanUrl)) return result;

  const filename = toFilename(cleanUrl);
  if (!isAbsolute(filename)) return result;

  // Anything outside the project root is somebody else's code — including
  // tracr's own packages, which a workspace symlink resolves to a real path
  // outside node_modules. Instrumenting those builds an import cycle back
  // into the runtime.
  const rel = relative(root, filename);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return result;
  if (!filter(rel)) return result;

  const source =
    typeof result.source === "string"
      ? result.source
      : Buffer.from(result.source as Uint8Array).toString("utf8");

  const { socket: _socket, root: _root, include: _i, exclude: _e, ...pluginOptions } = pluginData;
  const siteBase = nextSiteBase;

  let transformed;
  try {
    transformed = await transformAsync(source, {
      filename,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
      parserOpts: {
        plugins: parserPlugins(cleanUrl) as NonNullable<
          TransformOptions["parserOpts"]
        >["plugins"],
      },
      plugins: [[tracrBabelPlugin, { ...resolveOptions(pluginOptions), siteIdBase: siteBase }]],
    });
  } catch {
    // A transform failure must not take down the app; ship the original.
    return result;
  }

  if (transformed?.code == null) return result;

  const table = (
    transformed.metadata as { tracr?: { siteTable?: SiteTable } } | undefined
  )?.tracr?.siteTable;
  if (table !== undefined) nextSiteBase += table.sites.length;

  const runtime = format === "commonjs" ? BOOT : "globalThis.__tracr";

  let code = bootLine(format);

  // Source names are process-wide, so the first instrumented file carries them.
  if (!sourcesRegistered) {
    sourcesRegistered = true;
    code += `${runtime}.registerSources(${JSON.stringify(pluginOptions.sources ?? [])});\n`;
  }

  if (table !== undefined && table.sites.length > 0) {
    code += `${runtime}.registerSites(${JSON.stringify(table)});\n`;
  }

  return { ...result, source: code + transformed.code };
};
