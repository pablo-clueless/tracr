import { DirectedGraph } from "graphology";

import type { CoreDelta, Skeleton } from "@pablo_clueless/protocol";

export type NodeLevel = "callsite" | "file" | "function";

export interface NodeAttributes {
  label: string;
  level: NodeLevel;
  parent: number | null;
  x: number;
  y: number;
  tainted: boolean;
  /** Tainted movement that never left this node. Renders on the node, not an edge. */
  internal: number;
  /** Distinct sinks reached here, and how many times. */
  sinks: number;
  sinkHits: number;
}

export interface EdgeAttributes {
  count: number;
  tainted: boolean;
  /**
   * Observed at runtime but absent from the static parse — usually taint
   * crossing an uninstrumented framework frame. Real, so it is drawn; inferred,
   * so it must not look like a declared edge.
   */
  inferred: boolean;
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
      internal: 0,
      sinks: 0,
      sinkHits: 0,
    });
  }

  for (const edge of skeleton.edges) {
    graph.addDirectedEdgeWithKey(String(edge.id), String(edge.source), String(edge.target), {
      count: 0,
      tainted: false,
      inferred: false,
    });
  }
};

/**
 * Key for an edge the skeleton never declared. Prefixed so it cannot collide
 * with a numeric skeleton edge id, and derived from the endpoints so the same
 * crossing updates one edge instead of accumulating duplicates.
 */
const inferredKey = (source: number, target: number): string => `i:${source}>${target}`;

/** Runtime is an overlay: edges light up and carry counts. Never add a node per call. */
export const applyDelta = (graph: TracrGraph, delta: CoreDelta): void => {
  for (const edge of delta.edges) {
    const key = String(edge.edgeId);
    if (!graph.hasEdge(key)) continue;
    graph.setEdgeAttribute(key, "count", edge.count);
    graph.setEdgeAttribute(key, "tainted", edge.tainted);
    markTainted(graph, graph.source(key), graph.target(key));
  }

  for (const crossing of delta.unmapped) {
    const source = String(crossing.source);
    const target = String(crossing.target);
    // The core resolved both ends against the skeleton it sent us, but a
    // reconnect can land a delta before the matching skeleton. Skip rather than
    // synthesising a node the graph has no label for.
    if (!graph.hasNode(source) || !graph.hasNode(target)) continue;

    const key = inferredKey(crossing.source, crossing.target);
    if (graph.hasEdge(key)) {
      graph.setEdgeAttribute(key, "count", crossing.count);
    } else {
      graph.addDirectedEdgeWithKey(key, source, target, {
        count: crossing.count,
        tainted: true,
        inferred: true,
      });
    }
    markTainted(graph, source, target);
  }

  for (const node of delta.internal) {
    const key = String(node.nodeId);
    if (!graph.hasNode(key)) continue;
    graph.setNodeAttribute(key, "internal", node.count);
    graph.setNodeAttribute(key, "tainted", true);
  }

  for (const node of delta.sinks) {
    const key = String(node.nodeId);
    if (!graph.hasNode(key)) continue;
    graph.setNodeAttribute(key, "sinks", node.sites);
    graph.setNodeAttribute(key, "sinkHits", node.count);
    graph.setNodeAttribute(key, "tainted", true);
  }
};

const markTainted = (graph: TracrGraph, source: string, target: string): void => {
  graph.setNodeAttribute(source, "tainted", true);
  graph.setNodeAttribute(target, "tainted", true);
};
