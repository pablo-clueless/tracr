import type { SiteId } from "./site.js";

/**
 * The static topology, parsed once before execution. Runtime is an overlay on
 * this: edges light up and carry counts. Never create a node per call.
 */
export const SkeletonNodeKind = {
  File: 0,
  Function: 1,
  CallSite: 2,
} as const;
export type SkeletonNodeKind = (typeof SkeletonNodeKind)[keyof typeof SkeletonNodeKind];

export interface SkeletonNode {
  id: number;
  kind: SkeletonNodeKind;
  label: string;
  parent: number | null;
  siteId: SiteId | null;
}

export interface SkeletonEdge {
  id: number;
  source: number;
  target: number;
}

export interface Skeleton {
  nodes: SkeletonNode[];
  edges: SkeletonEdge[];
}

/**
 * Core -> UI. Skeleton once, then deltas.
 *
 * JSON, not msgpack: this is one message per frame interval carrying an
 * already-collapsed graph, so the agent format's positional arrays buy nothing
 * and named fields let a cached UI bundle ignore a field a newer daemon added.
 */
export const UpdateTag = {
  Skeleton: 0,
  Delta: 1,
} as const;
export type UpdateTag = (typeof UpdateTag)[keyof typeof UpdateTag];

export interface EdgeDelta {
  edgeId: number;
  count: number;
  tainted: boolean;
}

/**
 * Taint crossed between two nodes the static parse never connected — usually an
 * uninstrumented framework frame. Real, so render it; inferred, so render it
 * differently from a declared edge.
 */
export interface UnmappedEdge {
  source: number;
  target: number;
  count: number;
}

/** Tainted movement that never left one node. Belongs on the node, not an edge. */
export interface NodeCount {
  nodeId: number;
  count: number;
}

export interface NodeSinks {
  nodeId: number;
  /** Distinct `(site, sink)` pairs that rolled up to this node. */
  sites: number;
  count: number;
}

export interface CoreDelta {
  tag: typeof UpdateTag.Delta;
  edges: EdgeDelta[];
  unmapped: UnmappedEdge[];
  internal: NodeCount[];
  sinks: NodeSinks[];
  /** Running total, not an increment: the UI displays it as-is. */
  droppedTotal: number;
  /** Flows naming a site the skeleton lacks — the parse and the run disagree. */
  unresolved: number;
}

export interface CoreSkeleton extends Skeleton {
  tag: typeof UpdateTag.Skeleton;
}

export type CoreUpdate = CoreDelta | CoreSkeleton;
