import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";

import { useGraphStore } from "../store/useGraphStore";

/** Cytoscape degrades past a few thousand elements. Drill down, don't dump. */
const RENDER_CEILING = 2000;

/** Fitting one node would otherwise zoom it to fill the screen. */
const MAX_ZOOM = 1.5;

/**
 * Without a stylesheet Cytoscape draws unlabelled grey circles, which is what
 * it did. The rules that matter:
 *
 * - a node carries its own name, or the graph is a set of anonymous dots;
 * - tainted is the signal the whole tool exists to show, so it is the one
 *   colour that stands out;
 * - an inferred edge is dashed. The static parse never predicted it, and it
 *   must not look like an edge that was declared;
 * - edge width grows with traffic, but on a log scale — a linear one lets a
 *   single hot edge flatten every other into a hairline.
 */
const STYLESHEET: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "font-size": 11,
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
      "text-max-width": "120px",
      color: "#111827",
      "background-color": "#e5e7eb",
      "border-color": "#9ca3af",
      "border-width": 1,
      shape: "round-rectangle",
      width: "label",
      height: "label",
      padding: "10px",
    },
  },
  {
    selector: "node[?tainted]",
    style: { "background-color": "#fee2e2", "border-color": "#b91c1c" },
  },
  // A node that reached a sink is where a person looks first.
  {
    selector: "node[sinks > 0]",
    style: { "border-width": 3, "border-color": "#b91c1c" },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "target-arrow-shape": "triangle",
      "line-color": "#9ca3af",
      "target-arrow-color": "#9ca3af",
      width: "mapData(weight, 0, 6, 1, 8)",
      label: "data(count)",
      "font-size": 9,
      color: "#6b7280",
      "text-background-color": "#ffffff",
      "text-background-opacity": 1,
    },
  },
  {
    selector: "edge[?tainted]",
    style: { "line-color": "#b91c1c", "target-arrow-color": "#b91c1c" },
  },
  { selector: "edge[?inferred]", style: { "line-style": "dashed" } },
];

interface VisualizerProps {
  /** Asks the core for a node's derivation. Absent when nothing is connected. */
  onInspect?: (nodeId: number) => void;
}

export const Visualizer = ({ onInspect }: VisualizerProps = {}) => {
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);

  const graph = useGraphStore((s) => s.graph);
  const version = useGraphStore((s) => s.version);
  const topology = useGraphStore((s) => s.topology);
  const level = useGraphStore((s) => s.level);
  const selectEdge = useGraphStore((s) => s.selectEdge);

  useEffect(() => {
    if (container.current === null) return;

    cy.current = cytoscape({
      container: container.current,
      layout: { name: "preset" },
      style: STYLESHEET,
      maxZoom: MAX_ZOOM,
      elements: [],
    });

    cy.current.on("tap", "edge", (event) => selectEdge(event.target.id() as string));
    // The chain query is by node: the core picks the busiest sink rolled up
    // there, because the person clicked a box rather than a line.
    cy.current.on("tap", "node", (event) => {
      const id = Number(event.target.id());
      if (Number.isFinite(id)) onInspect?.(id);
    });

    return () => {
      cy.current?.destroy();
      cy.current = null;
    };
  }, [selectEdge, onInspect]);

  useEffect(() => {
    const instance = cy.current;
    if (instance === null) return;

    const nodes = graph.filterNodes((_id, attrs) => attrs.level === level).slice(0, RENDER_CEILING);
    const visible = new Set(nodes);

    instance.batch(() => {
      instance.elements().remove();
      instance.add(
        nodes.map((id) => ({
          group: "nodes" as const,
          data: {
            id,
            label: graph.getNodeAttribute(id, "label"),
            tainted: graph.getNodeAttribute(id, "tainted"),
            sinks: graph.getNodeAttribute(id, "sinks"),
          },
          position: {
            x: graph.getNodeAttribute(id, "x"),
            y: graph.getNodeAttribute(id, "y"),
          },
        })),
      );
      instance.add(
        graph
          .filterEdges((_key, _attrs, source, target) => visible.has(source) && visible.has(target))
          .map((key) => ({
            group: "edges" as const,
            data: {
              id: key,
              source: graph.source(key),
              target: graph.target(key),
              count: graph.getEdgeAttribute(key, "count"),
              // Log-scaled so one hot edge cannot flatten the rest.
              weight: Math.log10(graph.getEdgeAttribute(key, "count") + 1),
              tainted: graph.getEdgeAttribute(key, "tainted"),
              inferred: graph.getEdgeAttribute(key, "inferred"),
            },
          })),
      );
    });

    // `preset` puts elements wherever the layout said, which can be entirely
    // outside the viewport — without this the graph renders correctly and is
    // invisible. Fitted only when the topology or level changed: doing it on
    // every count delta would yank the view while a person is reading it.
    instance.fit(undefined, 40);
  }, [graph, level, topology]);

  // Counts changed but nothing moved, so redraw without touching the viewport.
  // Nodes are updated here too: taint and sink counts arrive on an ordinary
  // delta, which bumps `version` and not `topology`, so leaving them out of
  // this pass left every node drawn as though nothing had ever reached it.
  useEffect(() => {
    const instance = cy.current;
    if (instance === null) return;

    instance.batch(() => {
      instance.nodes().forEach((node) => {
        const id = node.id();
        if (!graph.hasNode(id)) return;
        node.data("tainted", graph.getNodeAttribute(id, "tainted"));
        node.data("sinks", graph.getNodeAttribute(id, "sinks"));
      });
      instance.edges().forEach((edge) => {
        const key = edge.id();
        if (!graph.hasEdge(key)) return;
        const count = graph.getEdgeAttribute(key, "count");
        edge.data("count", count);
        edge.data("weight", Math.log10(count + 1));
      });
    });
  }, [graph, version]);

  return <div ref={container} style={{ width: "100%", height: "100%" }} />;
};
