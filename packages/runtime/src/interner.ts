import {
  CombineOp,
  UNTAINTED,
  type DagNode,
  type Label,
  type SiteId,
} from "@pablo_clueless/protocol";

/**
 * Hash-consed provenance DAG. Identical `(op, siteId, parents)` always yields
 * the same index, so union is a hash lookup and lineage is structurally shared.
 *
 * Index 0 is reserved for untainted and is never stored.
 */
export class Interner {
  private readonly nodes: DagNode[] = [];
  private readonly index = new Map<string, Label>();

  origin(sourceId: number, siteId: SiteId): Label {
    return this.intern(`o:${sourceId}:${siteId}`, {
      kind: 0,
      sourceId,
      siteId,
    });
  }

  combine(op: CombineOp, siteId: SiteId, parents: Label[]): Label {
    const live = parents.filter((p) => p !== UNTAINTED);
    if (live.length === 0) return UNTAINTED;
    live.sort((a, b) => a - b);
    return this.intern(`c:${op}:${siteId}:${live.join(",")}`, {
      kind: 1,
      op,
      siteId,
      parents: live,
    });
  }

  /**
   * Both untainted is the only case that does no work. Any tainted operand
   * makes this a real derivation step, and the step is what gets rendered.
   */
  union(a: Label, b: Label, siteId: SiteId): Label {
    if (a === UNTAINTED && b === UNTAINTED) return UNTAINTED;
    return this.combine(CombineOp.Binary, siteId, [a, b]);
  }

  node(label: Label): DagNode | undefined {
    return label === UNTAINTED ? undefined : this.nodes[label - 1];
  }

  get size(): number {
    return this.nodes.length;
  }

  private intern(key: string, node: DagNode): Label {
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    const label = this.nodes.push(node) as Label;
    this.index.set(key, label);
    return label;
  }
}
