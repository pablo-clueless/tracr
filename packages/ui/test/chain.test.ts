import { describe, expect, it } from "vitest";
import {
  CombineOp,
  DagNodeKind,
  SkeletonNodeKind,
  UpdateTag,
  type ChainStep,
  type CoreChain,
  type Skeleton,
} from "@pablo_clueless/protocol";

import { applySkeleton, createGraph } from "../src/graph/model";
import { describeSite, toRows } from "../src/graph/chain";

/**
 * `src/routes.ts` holding `handler`, holding a call site — the shape the core
 * builds from a site table.
 */
const skeleton: Skeleton = {
  nodes: [
    { id: 1, kind: SkeletonNodeKind.File, label: "src/routes.ts", parent: null, siteId: null },
    { id: 2, kind: SkeletonNodeKind.Function, label: "handler", parent: 1, siteId: null },
    { id: 3, kind: SkeletonNodeKind.CallSite, label: "4:22", parent: 2, siteId: 100 },
  ],
  edges: [],
};

const graph = () => {
  const g = createGraph();
  applySkeleton(g, skeleton);
  return g;
};

const step = (over: Partial<ChainStep> & Pick<ChainStep, "label">): ChainStep => ({
  kind: DagNodeKind.Combine,
  op: CombineOp.Binary,
  sourceId: null,
  siteId: 100,
  nodeId: 3,
  parents: [],
  ...over,
});

const chain = (steps: ChainStep[], truncated = false): CoreChain => ({
  tag: UpdateTag.Chain,
  nodeId: 1,
  steps,
  truncated,
});

describe("describeSite", () => {
  it("names a site by walking up to the file", () => {
    expect(describeSite(graph(), 3)).toBe("src/routes.ts › handler › 4:22");
  });

  it("says so rather than inventing a location it does not have", () => {
    // A site the static parse never saw. Guessing a file would be a lie the
    // reader has no way to detect.
    expect(describeSite(graph(), null)).toBe("unknown site");
    expect(describeSite(graph(), 999)).toBe("unknown site");
  });

  it("refuses to loop on a cyclic parent chain", () => {
    const g = createGraph();
    applySkeleton(g, {
      nodes: [
        { id: 1, kind: SkeletonNodeKind.CallSite, label: "a", parent: 2, siteId: 1 },
        { id: 2, kind: SkeletonNodeKind.CallSite, label: "b", parent: 1, siteId: 2 },
      ],
      edges: [],
    });

    expect(() => describeSite(g, 1)).not.toThrow();
  });
});

describe("toRows", () => {
  it("numbers the chain from the source forwards", () => {
    const rows = toRows(
      chain([
        step({ label: 5, kind: DagNodeKind.Origin, op: null, sourceId: 7 }),
        step({ label: 6, op: CombineOp.Builtin, parents: [5] }),
        step({ label: 9, op: CombineOp.Template, parents: [6] }),
      ]),
      graph(),
    );

    expect(rows.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.operation)).toEqual(["origin", "builtin", "template"]);
  });

  it("refers to parents by position, never by raw label", () => {
    // A label is an internal index whose meaning shifts as the DAG grows; it
    // means nothing to the person reading the panel.
    const rows = toRows(
      chain([
        step({ label: 41, kind: DagNodeKind.Origin, op: null, sourceId: 0 }),
        step({ label: 77, parents: [41] }),
      ]),
      graph(),
    );

    expect(rows[1]?.from).toEqual([1]);
  });

  it("drops a parent the chain does not contain", () => {
    // Cut by a cap. Showing #undefined would be worse than showing nothing;
    // `truncated` already tells the reader the chain is partial.
    const rows = toRows(chain([step({ label: 8, parents: [999] })], true), graph());

    expect(rows[0]?.from).toEqual([]);
  });

  it("renders an unknown op without pretending to name it", () => {
    const rows = toRows(chain([step({ label: 1, op: 42 })]), graph());

    expect(rows[0]?.operation).toBe("op 42");
  });

  it("resolves every step to a place in the source", () => {
    const rows = toRows(chain([step({ label: 1 })]), graph());

    expect(rows[0]?.where).toBe("src/routes.ts › handler › 4:22");
  });

  it("has no rows for a truncated chain that recorded nothing", () => {
    expect(toRows(chain([], true), graph())).toEqual([]);
  });
});
