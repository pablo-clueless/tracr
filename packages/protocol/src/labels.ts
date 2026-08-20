import type { SiteId } from "./site.js";

/** `u32` index into the hash-consed provenance DAG. */
export type Label = number;

/** Reserved. Every operation must short-circuit on this before doing any work. */
export const UNTAINTED: Label = 0;

export const isUntainted = (label: Label): boolean => label === UNTAINTED;

export const DagNodeKind = {
  Origin: 0,
  Combine: 1,
} as const;
export type DagNodeKind = (typeof DagNodeKind)[keyof typeof DagNodeKind];

export const CombineOp = {
  Binary: 0,
  Assign: 1,
  Template: 2,
  Property: 3,
  Call: 4,
  Return: 5,
  Builtin: 6,
  Spread: 7,
  /** An array or object literal holding tainted parts. */
  Container: 8,
} as const;
export type CombineOp = (typeof CombineOp)[keyof typeof CombineOp];

/** A declared source: where taint originates. */
export interface OriginNode {
  kind: typeof DagNodeKind.Origin;
  sourceId: number;
  siteId: SiteId;
}

/** Derived from N parents. Hash-consed on `(op, siteId, parents)`. */
export interface CombineNode {
  kind: typeof DagNodeKind.Combine;
  op: CombineOp;
  siteId: SiteId;
  parents: Label[];
}

export type DagNode = CombineNode | OriginNode;
