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

/** Core -> UI. Skeleton once, then deltas. */
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

export interface CoreDelta {
  tag: typeof UpdateTag.Delta;
  edges: EdgeDelta[];
  droppedTotal: number;
}

export interface CoreSkeleton extends Skeleton {
  tag: typeof UpdateTag.Skeleton;
}

export type CoreUpdate = CoreDelta | CoreSkeleton;
