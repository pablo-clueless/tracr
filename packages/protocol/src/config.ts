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
}

export interface TracrAdapter {
  name: string;
  sources: SourceSpec[];
  sinks: SinkSpec[];
  shims?: ShimSpec[];
}
