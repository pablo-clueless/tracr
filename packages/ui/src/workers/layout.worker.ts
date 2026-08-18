import forceAtlas2 from "graphology-layout-forceatlas2";
import { DirectedGraph } from "graphology";

import type { EdgeAttributes, NodeAttributes } from "../graph/model";

export interface LayoutRequest {
  nodes: { id: string; x: number; y: number }[];
  edges: { source: string; target: string }[];
  iterations: number;
}

export type LayoutResult = Record<string, { x: number; y: number }>;

/** Layout runs here so the main thread never blocks on ForceAtlas2. */
self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { nodes, edges, iterations } = event.data;
  const graph = new DirectedGraph<NodeAttributes, EdgeAttributes>();

  for (const node of nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y } as NodeAttributes);
  }
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.mergeDirectedEdge(edge.source, edge.target);
    }
  }

  forceAtlas2.assign(graph, { iterations, settings: forceAtlas2.inferSettings(graph) });

  const positions: LayoutResult = {};
  graph.forEachNode((id, attrs) => {
    positions[id] = { x: attrs.x, y: attrs.y };
  });

  self.postMessage(positions);
};
