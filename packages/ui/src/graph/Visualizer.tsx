import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";

import { useGraphStore } from "../store/useGraphStore";

/** Cytoscape degrades past a few thousand elements. Drill down, don't dump. */
const RENDER_CEILING = 2000;

export const Visualizer = () => {
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);

  const graph = useGraphStore((s) => s.graph);
  const version = useGraphStore((s) => s.version);
  const level = useGraphStore((s) => s.level);
  const selectEdge = useGraphStore((s) => s.selectEdge);

  useEffect(() => {
    if (container.current === null) return;

    cy.current = cytoscape({
      container: container.current,
      layout: { name: "preset" },
      elements: [],
    });

    cy.current.on("tap", "edge", (event) => selectEdge(event.target.id() as string));

    return () => {
      cy.current?.destroy();
      cy.current = null;
    };
  }, [selectEdge]);

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
          data: { id, label: graph.getNodeAttribute(id, "label") },
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
            },
          })),
      );
    });
  }, [graph, version, level]);

  return <div ref={container} style={{ width: "100%", height: "100%" }} />;
};
