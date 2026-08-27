import { CombineOp, DagNodeKind, type ChainStep, type CoreChain } from "@pablo_clueless/protocol";
import type { TracrGraph } from "./model";

/**
 * Turning a derivation into something a person reads.
 *
 * Kept apart from the component because this is where the meaning is: which
 * step came from which, and where in the source each one happened. Rendering it
 * is a table; deciding what the table says is this.
 */

/** Reverse of `CombineOp`, for display. */
const OP_NAMES: Record<number, string> = {
  [CombineOp.Binary]: "binary",
  [CombineOp.Assign]: "assign",
  [CombineOp.Template]: "template",
  [CombineOp.Property]: "property",
  [CombineOp.Call]: "call",
  [CombineOp.Return]: "return",
  [CombineOp.Builtin]: "builtin",
  [CombineOp.Spread]: "spread",
  [CombineOp.Container]: "container",
};

export interface ChainRow {
  /** 1-based position, which is what `from` refers to. */
  index: number;
  label: number;
  /** `origin` for a source, otherwise the combine's operation. */
  operation: string;
  /**
   * Parents as positions in this chain — `#1, #2` — never raw labels. A label
   * is an internal index and means nothing to the person reading.
   */
  from: number[];
  /** Where in the source this happened, as far as the skeleton knows. */
  where: string;
}

/** `src/routes.ts › handler › 4:22`, from whatever the skeleton has. */
export const describeSite = (graph: TracrGraph, nodeId: number | null): string => {
  if (nodeId === null || !graph.hasNode(String(nodeId))) return "unknown site";

  const parts: string[] = [];
  let current: string | null = String(nodeId);

  // Bounded by the node count: a malformed parent cycle must not hang the panel.
  for (let hops = 0; current !== null && hops <= graph.order; hops += 1) {
    parts.push(graph.getNodeAttribute(current, "label"));
    // Annotated because `current` is assigned from it: without this the two
    // infer through each other and TS gives up.
    const parent: number | null = graph.getNodeAttribute(current, "parent");
    current = parent === null ? null : String(parent);
    if (current !== null && !graph.hasNode(current)) break;
  }

  return parts.reverse().join(" › ");
};

const operationOf = (step: ChainStep): string => {
  if (step.kind === DagNodeKind.Origin) return "origin";
  return step.op === null ? "combine" : (OP_NAMES[step.op] ?? `op ${String(step.op)}`);
};

/**
 * The chain as rows, origins first.
 *
 * A parent the chain does not contain is dropped from `from` rather than shown
 * as a dangling reference: it was cut by a cap, and the `truncated` flag already
 * says the chain is partial.
 */
export const toRows = (chain: CoreChain, graph: TracrGraph): ChainRow[] => {
  const position = new Map<number, number>();
  chain.steps.forEach((step, index) => position.set(step.label, index + 1));

  return chain.steps.map((step, index) => ({
    index: index + 1,
    label: step.label,
    operation: operationOf(step),
    from: step.parents
      .map((parent) => position.get(parent))
      .filter((at): at is number => at !== undefined),
    where: describeSite(graph, step.nodeId),
  }));
};
