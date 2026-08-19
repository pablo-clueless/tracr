import type { SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

export interface TracrPluginOptions {
  /** Micromatch globs. `node_modules` is always excluded. */
  include: string[];
  exclude: string[];
  sources: SourceSpec[];
  sinks: SinkSpec[];
  /** Identifier the transform emits calls against. */
  runtimeGlobal: string;
  /** Where the site side table is written. Nothing is emitted when null. */
  siteTableOut: string | null;
}

export const defaultOptions: TracrPluginOptions = {
  include: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
  exclude: ["**/node_modules/**", "**/dist/**"],
  sources: [],
  sinks: [],
  runtimeGlobal: "__tracr",
  siteTableOut: null,
};

export const resolveOptions = (options: Partial<TracrPluginOptions> = {}): TracrPluginOptions => ({
  ...defaultOptions,
  ...options,
  exclude: [...defaultOptions.exclude, ...(options.exclude ?? [])],
});
