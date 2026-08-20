import {
  CombineOp,
  DagNodeKind,
  UNTAINTED,
  type DagNode,
  type Label,
  type SiteId,
  type SiteInfo,
} from "@pablo_clueless/protocol";

import type { Interner } from "./interner.js";

export interface ChainStep {
  label: Label;
  node: DagNode;
  depth: number;
}

const OP_NAMES: Record<number, string> = {
  [CombineOp.Binary]: "binary",
  [CombineOp.Assign]: "assign",
  [CombineOp.Template]: "template",
  [CombineOp.Property]: "property",
  [CombineOp.Call]: "call",
  [CombineOp.Return]: "return",
  [CombineOp.Builtin]: "builtin",
  [CombineOp.Spread]: "spread",
};

/**
 * Walks a label back to its origins, deepest first, so the result reads as a
 * derivation: sources at the top, the queried label at the bottom.
 *
 * Shared subtrees are visited once. Because the DAG is hash-consed it can only
 * ever point at strictly smaller indices, so this cannot cycle.
 */
export const chain = (interner: Interner, label: Label): ChainStep[] => {
  if (label === UNTAINTED) return [];

  const steps: ChainStep[] = [];
  const seen = new Set<Label>();

  const walk = (current: Label, depth: number): void => {
    if (current === UNTAINTED || seen.has(current)) return;
    seen.add(current);

    const node = interner.node(current);
    if (node === undefined) return;

    if (node.kind === DagNodeKind.Combine) {
      for (const parent of node.parents) walk(parent, depth + 1);
    }
    steps.push({ label: current, node, depth });
  };

  walk(label, 0);
  return steps;
};

export interface FormatOptions {
  /** Site side table, so a step can name a file and line instead of an integer. */
  sites?: Map<SiteId, SiteInfo>;
  sourceNames?: Map<number, string>;
}

const formatSite = (siteId: SiteId, options: FormatOptions): string => {
  const info = options.sites?.get(siteId);
  if (info === undefined) return `site ${siteId}`;
  const where = `${info.file}:${info.line}:${info.col}`;
  return info.fnName === null ? where : `${where} (${info.fnName})`;
};

/** Console dump for the Phase 0 spike, before any daemon or UI exists. */
export const formatChain = (
  interner: Interner,
  label: Label,
  options: FormatOptions = {},
): string => {
  const steps = chain(interner, label);
  if (steps.length === 0) return "untainted";

  return steps
    .map(({ label: id, node }) => {
      const site = formatSite(node.siteId, options);
      if (node.kind === DagNodeKind.Origin) {
        const name = options.sourceNames?.get(node.sourceId) ?? `source ${node.sourceId}`;
        return `  #${id} origin ${name} at ${site}`;
      }
      const op = OP_NAMES[node.op] ?? `op ${node.op}`;
      const parents = node.parents.map((p) => `#${p}`).join(", ");
      return `  #${id} ${op}(${parents}) at ${site}`;
    })
    .join("\n");
};
