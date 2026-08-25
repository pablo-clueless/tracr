import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { ShimSpec, SinkSpec, SourceSpec, TracrAdapter } from "@pablo_clueless/protocol";

export interface TracrConfig {
  /** Adapter package names, e.g. `["@pablo_clueless/react"]`. */
  adapters: string[];
  sources: SourceSpec[];
  sinks: SinkSpec[];
  /** Contributed by adapters; a config never declares these directly. */
  shims: ShimSpec[];
  include: string[];
  exclude: string[];
  /** Unix socket (Node) the daemon listens on. */
  socket: string;
  /** Port the UI connects to. */
  uiPort: number;
}

export const defaultConfig: TracrConfig = {
  adapters: [],
  sources: [],
  sinks: [],
  shims: [],
  // Every extension an agent can instrument. `.vue` / `.svelte` are here
  // because the bundler plugin runs `enforce: 'post'` and sees compiled JS
  // behind an id that still carries the original extension.
  include: ["src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte}"],
  exclude: ["**/node_modules/**", "**/dist/**"],
  socket: ".tracr/daemon.sock",
  uiPort: 7331,
};

export const defineConfig = (config: Partial<TracrConfig>): TracrConfig => ({
  ...defaultConfig,
  ...config,
});

const CANDIDATES = [
  "tracr.config.ts",
  "tracr.config.mts",
  "tracr.config.mjs",
  "tracr.config.js",
] as const;

/**
 * A `.ts` config only imports directly on a Node new enough to strip types.
 * Rather than gate on a version, try the import and fall back to transpiling.
 */
const importDirect = async (file: string): Promise<unknown> =>
  (await import(pathToFileURL(file).href)) as unknown;

/** Resolved from here, not the config's directory, which need not have Babel. */
const tsPreset = (): string => createRequire(import.meta.url).resolve("@babel/preset-typescript");

/**
 * Babel-strip the config and import the result from the same directory. The
 * location matters: a `data:` URL cannot resolve the bare `@pablo_clueless/tracr`
 * specifier every config imports `defineConfig` from.
 */
const importTranspiled = async (file: string): Promise<unknown> => {
  const source = await readFile(file, "utf8");
  const output = await transformAsync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    presets: [tsPreset()],
  });

  const stamp = createHash("sha1").update(file).digest("hex").slice(0, 8);
  const scratch = join(dirname(file), `tracr.config.${stamp}.mjs`);
  await writeFile(scratch, output?.code ?? source, "utf8");
  try {
    return (await import(`${pathToFileURL(scratch).href}?t=${Date.now()}`)) as unknown;
  } finally {
    await unlink(scratch).catch(() => {});
  }
};

const findConfig = async (cwd: string): Promise<string | null> => {
  const entries = new Set(await readdir(cwd).catch(() => []));
  for (const name of CANDIDATES) if (entries.has(name)) return join(cwd, name);
  return null;
};

/** Accepts `export default`, or a named `config` export. */
const unwrap = (mod: unknown): Partial<TracrConfig> | null => {
  const ns = mod as { default?: unknown; config?: unknown };
  const value = ns.default ?? ns.config;
  return typeof value === "object" && value !== null ? (value as Partial<TracrConfig>) : null;
};

const unwrapAdapter = (mod: unknown): TracrAdapter | null => {
  const ns = mod as Record<string, unknown>;
  const candidates = [ns.default, ...Object.values(ns)];
  for (const value of candidates) {
    if (typeof value === "object" && value !== null && "sources" in value && "sinks" in value) {
      return value as TracrAdapter;
    }
  }
  return null;
};

/**
 * Adapters go in first so a project config can override a shipped spec by
 * declaring the same `id` later — last write wins on the id.
 */
const dedupe = <T extends { id: string }>(specs: T[]): T[] => {
  const byId = new Map<string, T>();
  for (const spec of specs) byId.set(spec.id, spec);
  return [...byId.values()];
};

const loadAdapters = async (
  names: string[],
  from: string,
): Promise<{ sources: SourceSpec[]; sinks: SinkSpec[]; shims: ShimSpec[] }> => {
  const sources: SourceSpec[] = [];
  const sinks: SinkSpec[] = [];
  const shims: ShimSpec[] = [];

  const require = createRequire(join(from, "noop.js"));

  for (const name of names) {
    let adapter: TracrAdapter | null = null;
    try {
      adapter = unwrapAdapter(await import(pathToFileURL(require.resolve(name)).href));
    } catch (error) {
      console.warn(`[tracr] adapter "${name}" could not be loaded: ${String(error)}`);
      continue;
    }
    if (adapter === null) {
      console.warn(`[tracr] adapter "${name}" exports no adapter object`);
      continue;
    }
    sources.push(...adapter.sources);
    sinks.push(...adapter.sinks);
    if (adapter.shims !== undefined) shims.push(...adapter.shims);
  }

  return { sources, sinks, shims };
};

/**
 * Reads `tracr.config.*` from `cwd` and folds in every adapter it names. A
 * missing config is not an error — it yields the defaults, which instrument
 * nothing because they declare no sources.
 */
export const loadConfig = async (cwd: string): Promise<TracrConfig> => {
  const file = await findConfig(cwd);
  if (file === null) return defaultConfig;

  let user: Partial<TracrConfig> | null = null;
  try {
    user = unwrap(await importDirect(file));
  } catch {
    try {
      user = unwrap(await importTranspiled(file));
    } catch (error) {
      console.warn(`[tracr] failed to load ${file}: ${String(error)}`);
      return defaultConfig;
    }
  }
  if (user === null) {
    console.warn(`[tracr] ${file} has no default export`);
    return defaultConfig;
  }

  const merged: TracrConfig = { ...defaultConfig, ...user };
  const adapters = await loadAdapters(merged.adapters, cwd);

  return {
    ...merged,
    sources: dedupe([...adapters.sources, ...merged.sources]),
    sinks: dedupe([...adapters.sinks, ...merged.sinks]),
    shims: dedupe([...adapters.shims, ...(user.shims ?? [])]),
  };
};

/**
 * Windows has no usable unix socket path convention, so the configured path is
 * only meaningful on posix; elsewhere it becomes a named pipe keyed on the
 * project directory so two projects never collide.
 */
export const resolveSocketPath = (cwd: string, socket: string): string => {
  if (process.platform === "win32") {
    if (socket.startsWith("\\\\")) return socket;
    const key = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\tracr-${key}`;
  }
  return isAbsolute(socket) ? socket : resolve(cwd, socket);
};
