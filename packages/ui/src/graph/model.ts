import { DirectedGraph } from "graphology";
import type { CoreDelta, Skeleton } from "@tracr/protocol";

export type NodeLevel = "callsite" | "file" | "function";

export interface NodeAttributes {
  label: string;
  level: NodeLevel;
  parent: number | null;
  x: number;
  y: number;
  tainted: boolean;
}

export interface EdgeAttributes {
  count: number;
  tainted: boolean;
}

export type TracrGraph = DirectedGraph<NodeAttributes, EdgeAttributes>;

/**
 * graphology is the single source of truth. Cytoscape renders from it and never
 * mutates back: if both own state they drift and the bug is unfindable.
 */
export const createGraph = (): TracrGraph => new DirectedGraph<NodeAttributes, EdgeAttributes>();

const LEVELS: NodeLevel[] = ["file", "function", "callsite"];

export const applySkeleton = (graph: TracrGraph, skeleton: Skeleton): void => {
  graph.clear();

  for (const node of skeleton.nodes) {
    graph.addNode(String(node.id), {
      label: node.label,
      level: LEVELS[node.kind] ?? "file",
      parent: node.parent,
      x: 0,
      y: 0,
      tainted: false,
    });
  }

  for (const edge of skeleton.edges) {
    graph.addDirectedEdgeWithKey(String(edge.id), String(edge.source), String(edge.target), {
      count: 0,
      tainted: false,
    });
  }
};

/** Runtime is an overlay: edges light up and carry counts. Never add a node per call. */
export const applyDelta = (graph: TracrGraph, delta: CoreDelta): void => {
  for (const edge of delta.edges) {
    const key = String(edge.edgeId);
    if (!graph.hasEdge(key)) continue;
    graph.setEdgeAttribute(key, "count", edge.count);
    graph.setEdgeAttribute(key, "tainted", edge.tainted);
  }
};
