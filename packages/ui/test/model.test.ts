import { describe, expect, it } from "vitest";
import {
  SkeletonNodeKind,
  UpdateTag,
  type CoreDelta,
  type Skeleton,
} from "@pablo_clueless/protocol";

import { applyDelta, applySkeleton, createGraph } from "../src/graph/model";

/**
 * graphology is the single source of truth the renderer reads from, so what it
 * holds after a delta is what the person sees. These are the assertions the
 * integration suite cannot make: it checks the frames on the wire, not what the
 * UI does with them.
 */

const skeleton: Skeleton = {
  nodes: [
    { id: 1, kind: SkeletonNodeKind.File, label: "src/routes.ts", parent: null, siteId: null },
    { id: 2, kind: SkeletonNodeKind.File, label: "src/db.ts", parent: null, siteId: null },
  ],
  edges: [{ id: 10, source: 1, target: 2 }],
};

const graph = () => {
  const g = createGraph();
  applySkeleton(g, skeleton);
  return g;
};

const delta = (over: Partial<CoreDelta> = {}): CoreDelta => ({
  tag: UpdateTag.Delta,
  edges: [],
  unmapped: [],
  internal: [],
  sinks: [],
  droppedTotal: 0,
  unresolved: 0,
  truncated: 0,
  lost: 0,
  ...over,
});

describe("applySkeleton", () => {
  it("builds the topology with every edge dark", () => {
    const g = graph();

    expect(g.order).toBe(2);
    expect(g.size).toBe(1);
    expect(g.getEdgeAttribute("10", "count")).toBe(0);
    expect(g.getEdgeAttribute("10", "tainted")).toBe(false);
  });

  it("replaces the previous topology rather than merging into it", () => {
    // Node ids only mean anything against the skeleton that defined them.
    const g = graph();
    applySkeleton(g, { nodes: [], edges: [] });

    expect(g.order).toBe(0);
  });
});

describe("applyDelta", () => {
  it("lights a declared edge and both its ends", () => {
    const g = graph();

    applyDelta(g, delta({ edges: [{ edgeId: 10, count: 42, tainted: true }] }));

    expect(g.getEdgeAttribute("10", "count")).toBe(42);
    expect(g.getNodeAttribute("1", "tainted")).toBe(true);
    expect(g.getNodeAttribute("2", "tainted")).toBe(true);
  });

  it("draws an undeclared crossing as an inferred edge", () => {
    const g = graph();

    applyDelta(g, delta({ unmapped: [{ source: 2, target: 1, count: 3 }] }));

    expect(g.size).toBe(2);
    const added = g.edges().find((key) => key !== "10");
    expect(added).toBeDefined();
    expect(g.getEdgeAttribute(added as string, "inferred")).toBe(true);
  });

  it("updates a repeated crossing instead of stacking duplicates", () => {
    const g = graph();

    applyDelta(g, delta({ unmapped: [{ source: 2, target: 1, count: 3 }] }));
    applyDelta(g, delta({ unmapped: [{ source: 2, target: 1, count: 9 }] }));

    expect(g.size).toBe(2);
    const added = g.edges().find((key) => key !== "10") as string;
    expect(g.getEdgeAttribute(added, "count")).toBe(9);
  });

  it("keeps an inferred edge distinguishable from a declared one", () => {
    // The parse made no claim about it, so it must not render as though it did.
    const g = graph();

    applyDelta(
      g,
      delta({
        edges: [{ edgeId: 10, count: 1, tainted: true }],
        unmapped: [{ source: 2, target: 1, count: 1 }],
      }),
    );

    expect(g.getEdgeAttribute("10", "inferred")).toBe(false);
  });

  it("puts movement that never left a module on the node", () => {
    const g = graph();

    applyDelta(g, delta({ internal: [{ nodeId: 1, count: 9 }] }));

    expect(g.getNodeAttribute("1", "internal")).toBe(9);
    expect(g.getNodeAttribute("1", "tainted")).toBe(true);
  });

  it("records sinks reached at a node", () => {
    const g = graph();

    applyDelta(g, delta({ sinks: [{ nodeId: 2, sites: 3, count: 40 }] }));

    expect(g.getNodeAttribute("2", "sinks")).toBe(3);
    expect(g.getNodeAttribute("2", "sinkHits")).toBe(40);
  });

  it("ignores a delta naming nodes the current skeleton lacks", () => {
    // A delta can arrive before the skeleton it belongs to, on reconnect.
    // Synthesising a node the graph has no label for would put a blank box on
    // screen.
    const g = graph();

    expect(() =>
      applyDelta(
        g,
        delta({
          edges: [{ edgeId: 999, count: 1, tainted: true }],
          unmapped: [{ source: 998, target: 997, count: 1 }],
          internal: [{ nodeId: 996, count: 1 }],
          sinks: [{ nodeId: 995, sites: 1, count: 1 }],
        }),
      ),
    ).not.toThrow();

    expect(g.order).toBe(2);
    expect(g.size).toBe(1);
  });
});

describe("relayout triggering", () => {
  /**
   * The Phase 4 gate is live updates without layout thrash. Layout keys off
   * this return value, so what it reports is the difference between a graph
   * that settles and one that jumps while a person is reading it.
   */

  it("does not ask for a relayout when only counts moved", () => {
    const g = graph();

    const changed = applyDelta(g, delta({ edges: [{ edgeId: 10, count: 42, tainted: true }] }));

    expect(changed).toBe(false);
  });

  it("does not ask for a relayout for sinks or internal movement", () => {
    const g = graph();

    const changed = applyDelta(
      g,
      delta({ internal: [{ nodeId: 1, count: 9 }], sinks: [{ nodeId: 2, sites: 1, count: 5 }] }),
    );

    expect(changed).toBe(false);
  });

  it("asks for a relayout when an inferred edge first appears", () => {
    const g = graph();

    const changed = applyDelta(g, delta({ unmapped: [{ source: 2, target: 1, count: 1 }] }));

    expect(changed).toBe(true);
  });

  it("stops asking once that edge exists", () => {
    // The crossing repeats every tick under load. Relaying out each time is
    // exactly the thrash the gate forbids.
    const g = graph();
    applyDelta(g, delta({ unmapped: [{ source: 2, target: 1, count: 1 }] }));

    const changed = applyDelta(g, delta({ unmapped: [{ source: 2, target: 1, count: 99 }] }));

    expect(changed).toBe(false);
  });

  it("does not ask for a relayout for a crossing it had to skip", () => {
    // Nodes absent from the current skeleton add no element, so there is
    // nothing new to place.
    const g = graph();

    const changed = applyDelta(g, delta({ unmapped: [{ source: 998, target: 997, count: 1 }] }));

    expect(changed).toBe(false);
  });
});
