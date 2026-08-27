import { beforeEach, describe, expect, it } from "vitest";
import {
  SkeletonNodeKind,
  UpdateTag,
  type CoreDelta,
  type Skeleton,
} from "@pablo_clueless/protocol";

import { createGraph } from "../src/graph/model";
import { useGraphStore } from "../src/store/useGraphStore";

/**
 * Phase 4's gate: live updates without layout thrash while the app is under
 * load.
 *
 * Layout is the expensive thing on this side — ForceAtlas2 over the whole graph
 * — and it is triggered by `topology`, not `version`. So the gate reduces to a
 * countable claim: under a sustained delta stream, `version` moves every frame
 * and `topology` does not. These drive the real store rather than a stand-in,
 * because the bug this guards against would live in exactly that wiring.
 */

const NODES = 60;
const FRAMES = 1_000;

const skeleton = (): Skeleton => ({
  nodes: Array.from({ length: NODES }, (_, i) => ({
    id: i + 1,
    kind: SkeletonNodeKind.File,
    label: `src/mod${String(i)}.ts`,
    parent: null,
    siteId: null,
  })),
  edges: Array.from({ length: NODES - 1 }, (_, i) => ({
    id: 1_000 + i,
    source: i + 1,
    target: i + 2,
  })),
});

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

describe("under a sustained delta stream", () => {
  beforeEach(() => {
    // The store is a module singleton, so each test starts from a clean graph.
    useGraphStore.setState({ graph: createGraph(), version: 0, topology: 0, chain: null });
    useGraphStore.getState().ingestSkeleton(skeleton());
  });

  it("never relayouts for a count that only went up", () => {
    const before = useGraphStore.getState().topology;

    for (let frame = 1; frame <= FRAMES; frame += 1) {
      useGraphStore.getState().ingestDelta(
        delta({
          edges: Array.from({ length: NODES - 1 }, (_, i) => ({
            edgeId: 1_000 + i,
            count: frame,
            tainted: true,
          })),
        }),
      );
    }

    const state = useGraphStore.getState();
    expect(state.version).toBe(FRAMES + 1); // +1 for the skeleton
    // A thousand frames of traffic, and the graph never moved.
    expect(state.topology).toBe(before);
  });

  it("relayouts once for a new crossing, then stops", () => {
    const before = useGraphStore.getState().topology;

    for (let frame = 1; frame <= FRAMES; frame += 1) {
      useGraphStore
        .getState()
        .ingestDelta(delta({ unmapped: [{ source: 5, target: 40, count: frame }] }));
    }

    // The crossing repeats every frame; only its first appearance is new.
    expect(useGraphStore.getState().topology).toBe(before + 1);
  });

  it("relayouts once per distinct crossing, not once per frame", () => {
    const before = useGraphStore.getState().topology;
    const crossings = 12;

    for (let frame = 1; frame <= FRAMES; frame += 1) {
      const pair = frame % crossings;
      useGraphStore
        .getState()
        .ingestDelta(delta({ unmapped: [{ source: pair + 1, target: pair + 20, count: frame }] }));
    }

    expect(useGraphStore.getState().topology).toBe(before + crossings);
  });

  it("keeps counts accurate through the whole stream", () => {
    // Cheap is not the goal if the numbers stop being true.
    for (let frame = 1; frame <= FRAMES; frame += 1) {
      useGraphStore
        .getState()
        .ingestDelta(delta({ edges: [{ edgeId: 1_000, count: frame, tainted: true }] }));
    }

    expect(useGraphStore.getState().graph.getEdgeAttribute("1000", "count")).toBe(FRAMES);
  });

  it("adds no element for traffic on edges it already knows", () => {
    const graph = useGraphStore.getState().graph;
    const order = graph.order;
    const size = graph.size;

    for (let frame = 1; frame <= FRAMES; frame += 1) {
      useGraphStore.getState().ingestDelta(
        delta({
          edges: [{ edgeId: 1_000, count: frame, tainted: true }],
          internal: [{ nodeId: 1, count: frame }],
          sinks: [{ nodeId: 2, sites: 1, count: frame }],
        }),
      );
    }

    // Runtime is an overlay: never a node per call.
    expect(graph.order).toBe(order);
    expect(graph.size).toBe(size);
  });
});
