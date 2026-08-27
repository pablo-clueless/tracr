import { useEffect, useRef } from "react";

import { useGraphStore } from "../store/useGraphStore";
import type { LayoutRequest, LayoutResult } from "../workers/layout.worker";

/**
 * ForceAtlas2 in a worker, positions back into graphology.
 *
 * # Why this exists at all
 *
 * `applySkeleton` gives every node `x: 0, y: 0`, and the renderer takes those
 * as `preset` positions. Without a layout pass the entire graph draws on one
 * point — which is what happened, because the worker was written and never
 * instantiated.
 *
 * # Why it keys off topology, not version
 *
 * Counts move on every tick. Re-running the layout for a count would make the
 * graph jump while a person is reading it, which is the thrash the Phase 4 gate
 * is about. Only a new element changes where things belong.
 *
 * # Ownership
 *
 * graphology stays the single source of truth: the worker is handed a snapshot
 * and its answer is written back as node attributes. Cytoscape reads those. The
 * worker never talks to the renderer, and the renderer never moves a node.
 */

const ITERATIONS = 200;

export const useLayout = (): void => {
  const graph = useGraphStore((s) => s.graph);
  const topology = useGraphStore((s) => s.topology);
  const bumpVersion = useGraphStore((s) => s.bumpVersion);

  const worker = useRef<Worker | null>(null);
  // A layout that arrives after a newer one was requested is stale: applying it
  // would drag nodes back to where an older topology put them.
  const generation = useRef(0);

  useEffect(() => {
    const instance = new Worker(new URL("../workers/layout.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = instance;

    return () => {
      worker.current = null;
      instance.terminate();
    };
  }, []);

  useEffect(() => {
    const instance = worker.current;
    if (instance === null || graph.order === 0) return;

    generation.current += 1;
    const requested = generation.current;

    const onResult = (event: MessageEvent<LayoutResult>) => {
      if (requested !== generation.current) return;

      for (const [id, position] of Object.entries(event.data)) {
        if (!graph.hasNode(id)) continue;
        graph.setNodeAttribute(id, "x", position.x);
        graph.setNodeAttribute(id, "y", position.y);
      }
      bumpVersion();
    };

    instance.addEventListener("message", onResult, { once: true });

    const request: LayoutRequest = {
      nodes: graph.mapNodes((id, attrs) => ({ id, x: attrs.x, y: attrs.y })),
      edges: graph.mapEdges((_key, _attrs, source, target) => ({ source, target })),
      iterations: ITERATIONS,
    };
    instance.postMessage(request);

    return () => instance.removeEventListener("message", onResult);
  }, [graph, topology, bumpVersion]);
};
