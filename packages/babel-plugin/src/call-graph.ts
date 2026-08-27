import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

import type { CallEdge } from "@pablo_clueless/protocol";

/**
 * Static call edges, collected while the transform is already walking the tree.
 *
 * # Why the skeleton needs this
 *
 * The site table records where code *is*, never what calls what, so the
 * skeleton declared no edges and every observed crossing arrived as `unmapped`.
 * That is accurate but useless: if the parse predicts nothing, "the parse did
 * not predict this" stops being a signal.
 *
 * # Only identifier callees
 *
 * `helper()` names something this project may have instrumented. `db.query()`
 * names a method on a value whose definition is almost always outside the
 * instrumented set, and guessing which function it lands on would put an edge
 * on screen that nothing verified. Member calls are left to the sink machinery,
 * which identifies them by declaration rather than by inference.
 */
export class CallGraphBuilder {
  private readonly edges: CallEdge[] = [];
  private readonly seen = new Set<string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * Records a call, if its target is one that can be resolved later.
   *
   * `from` is the enclosing function, matching `SiteInfo.fnName`, so the core
   * can key both against the same containment tree.
   */
  add(path: NodePath<t.CallExpression>, from: string | null): void {
    const callee = path.node.callee;
    if (callee.type !== "Identifier") return;

    const loc = path.node.loc?.start;
    const edge: CallEdge = {
      from,
      to: callee.name,
      module: moduleOf(path, callee.name),
      file: this.file,
      line: loc?.line ?? 0,
      col: loc?.column ?? 0,
    };

    // A call in a loop is one edge, not one per iteration of the parse; the
    // same pair from the same place adds nothing.
    const key = `${edge.from ?? ""}|${edge.to}|${edge.module ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.edges.push(edge);
  }

  build(): CallEdge[] {
    return [...this.edges];
  }
}

/**
 * The module a callee came from, or `null` when it is declared in this file.
 *
 * An unresolved binding also yields `null`: it is a global like `fetch`, and
 * the core will fail to match it against any file, which is the right outcome.
 */
const moduleOf = (path: NodePath<t.CallExpression>, name: string): string | null => {
  const binding = path.scope.getBinding(name);
  if (binding === undefined || binding.kind !== "module") return null;

  const declaration = binding.path.parentPath;
  if (declaration === null || !declaration.isImportDeclaration()) return null;
  return declaration.node.source.value;
};
