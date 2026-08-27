import type { DagNodeKind } from "./labels.js";
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
  Chain: 2,
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
  /**
   * Derivation chains that hit the DAG's depth cap. A provenance panel must say
   * "the chain stops here" rather than implying it reached a source.
   */
  truncated: number;
  /**
   * Labels that aged out of an agent's translation table, or whose defining
   * event was dropped. Each was reported untainted, so this is the count of
   * flows the graph may be missing — a false negative, not a partial answer.
   */
  lost: number;
}

export interface CoreSkeleton extends Skeleton {
  tag: typeof UpdateTag.Skeleton;
}

/**
 * One step in a derivation, origins first.
 *
 * The product's whole claim: given a value at a sink, show the exact chain back
 * to its source. `nodeId` resolves the step to a place in the skeleton so the
 * UI can name a file and a line without a second round trip.
 */
export interface ChainStep {
  label: number;
  /** A `DagNodeKind`: origin or combine. */
  kind: DagNodeKind;
  /** A `CombineOp`, absent on an origin. */
  op: number | null;
  /** The declared source, absent on a combine. */
  sourceId: number | null;
  siteId: number;
  /** `null` when the static parse never saw the site. */
  nodeId: number | null;
  parents: number[];
}

/** Core -> UI, in reply to `{ chain: nodeId }`. */
export interface CoreChain {
  tag: typeof UpdateTag.Chain;
  /** Echoed back so a viewer can match a reply to the click that caused it. */
  nodeId: number;
  steps: ChainStep[];
  /** The chain hit a cap. Say so rather than presenting a partial chain whole. */
  truncated: boolean;
}

/** UI -> core. The only things a viewer may ask for. */
export type ViewerRequest = { chain: number } | { level: SkeletonNodeKind };

export type CoreUpdate = CoreChain | CoreDelta | CoreSkeleton;
