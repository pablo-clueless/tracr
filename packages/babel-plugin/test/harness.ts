import { transformSync } from "@babel/core";
import { TracrRuntime } from "@pablo_clueless/runtime";
import type { Label, SinkSpec, SiteTable, SourceSpec } from "@pablo_clueless/protocol";

import { tracrBabelPlugin } from "../src/plugin.js";
import type { TracrPluginOptions } from "../src/options.js";

export interface SinkHit {
  sinkId: number;
  site: number;
  label: Label;
}

export interface RunResult {
  runtime: TracrRuntime;
  out: Record<string, unknown>;
  sinks: SinkHit[];
  code: string;
  /** The derivation chain for the label that reached the first sink. */
  chain(): string;
}

export interface Transformed {
  code: string;
  siteTable: SiteTable;
}

export const transform = (
  source: string,
  options: Partial<TracrPluginOptions> = {},
): Transformed => {
  const result = transformSync(source, {
    filename: "/app/example.js",
    babelrc: false,
    configFile: false,
    plugins: [[tracrBabelPlugin, options]],
  });
  if (result?.code == null) throw new Error("transform produced no output");

  const meta = result.metadata as { tracr?: { siteTable: SiteTable } } | undefined;
  return {
    code: result.code,
    siteTable: meta?.tracr?.siteTable ?? { runId: 0, sites: [] },
  };
};

export interface RunOptions extends Partial<TracrPluginOptions> {
  /**
   * Values injected untransformed, standing in for uninstrumented framework
   * code — the frames where the argument side channel is dead.
   */
  externals?: Record<string, unknown>;
}

export const run = (source: string, options: RunOptions = {}): RunResult => {
  const { externals = {}, ...pluginOptions } = options;
  const { code, siteTable } = transform(source, pluginOptions);

  const runtime = new TracrRuntime();
  const sinks: SinkHit[] = [];
  runtime.onSink = (hit) => sinks.push(hit);
  runtime.registerSources((pluginOptions.sources ?? []) as SourceSpec[]);
  runtime.registerSites(siteTable);

  const out: Record<string, unknown> = {};
  const externalNames = Object.keys(externals);

  const fn = new Function("__tracr", "out", ...externalNames, code) as (
    rt: TracrRuntime,
    out: Record<string, unknown>,
    ...rest: unknown[]
  ) => void;

  fn(runtime, out, ...externalNames.map((name) => externals[name]));

  return {
    runtime,
    out,
    sinks,
    code,
    chain: () => (sinks[0] === undefined ? "no sink hit" : runtime.explain(sinks[0].label)),
  };
};

export const source = (id: string, path: string): SourceSpec => ({ id, module: "*", path });

export const sink = (id: string, path: string, args?: number[]): SinkSpec => ({
  id,
  module: "*",
  path,
  ...(args === undefined ? {} : { args }),
});
