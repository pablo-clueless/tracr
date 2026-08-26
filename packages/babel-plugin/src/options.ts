import type { ShimSpec, SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

export interface TracrPluginOptions {
  /** Micromatch globs. `node_modules` is always excluded. */
  include: string[];
  exclude: string[];
  sources: SourceSpec[];
  sinks: SinkSpec[];
  /** Framework bindings whose imports are redirected to an instrumented stand-in. */
  shims: ShimSpec[];
  /** Identifier the transform emits calls against. */
  runtimeGlobal: string;
  /**
   * First site ID this file may assign. Per-file numbering restarts at 1 by
   * default; an agent loading many files offsets each one so IDs stay unique
   * within a process.
   */
  siteIdBase: number;
  /** Where the site side table is written. Nothing is emitted when null. */
  siteTableOut: string | null;
}

export const defaultOptions: TracrPluginOptions = {
  include: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
  exclude: ["**/node_modules/**", "**/dist/**"],
  sources: [],
  sinks: [],
  shims: [],
  runtimeGlobal: "__tracr",
  siteIdBase: 0,
  siteTableOut: null,
};

export const resolveOptions = (options: Partial<TracrPluginOptions> = {}): TracrPluginOptions => ({
  ...defaultOptions,
  ...options,
  exclude: [...defaultOptions.exclude, ...(options.exclude ?? [])],
});
