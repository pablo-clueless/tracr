/**
 * Source and sink declarations. Adapters ship these; `tracr.config.ts` may add
 * project-specific entries.
 */
export interface SourceSpec {
  id: string;
  /** Module the binding comes from, or `*` for a global. */
  module: string;
  /** Dotted path within the module export, e.g. `req.body`. */
  path: string;
}

export interface SinkSpec {
  id: string;
  module: string;
  path: string;
  /** Argument positions that matter. Empty means all. */
  args?: number[];
}

/** Re-anchors taint across framework storage that the side channel cannot cross. */
export interface ShimSpec {
  id: string;
  module: string;
  export: string;
  /** Module to import this binding from instead. Without it the shim is inert. */
  via?: string;
}

export interface TracrAdapter {
  name: string;
  sources: SourceSpec[];
  sinks: SinkSpec[];
  shims?: ShimSpec[];
}

/**
 * The source a value gets when it arrives over the network already tainted.
 *
 * Never matched by the transform — `path` names nothing in the source, because
 * nothing in the source produces it. It is declared so it occupies an index in
 * the configured list, and minted at runtime by the propagation helper. Its
 * meaning is deliberately narrow: "this arrived dirty from another process",
 * not a reconstruction of what happened there.
 */
export const NETWORK_SOURCE: SourceSpec = {
  id: "tracr.network",
  module: "*",
  path: "<network>",
};

/**
 * Source and sink ids are positions in the configured array, so the transform
 * and the agent must be handed the same list in the same order. These turn a
 * declared string id back into that position.
 *
 * Returns `-1` when the spec is absent, matching `findIndex` — a caller that
 * ignores it would otherwise silently propagate under whatever spec sits at
 * index 0.
 */
export const sourceIdOf = (sources: SourceSpec[], id: string): number =>
  sources.findIndex((spec) => spec.id === id);

export const sinkIdOf = (sinks: SinkSpec[], id: string): number =>
  sinks.findIndex((spec) => spec.id === id);
