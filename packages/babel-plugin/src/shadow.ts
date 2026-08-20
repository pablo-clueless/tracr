import type { NodePath, Scope } from "@babel/traverse";
import type * as t from "@babel/types";

/**
 * `let x` gets a sibling `x$t` holding its label. The suffix is deliberately
 * not a valid identifier character sequence a human would type, so instrumented
 * code cannot collide with user bindings.
 */
export const shadowName = (name: string): string => `${name}$t`;

/**
 * Which bindings actually have a shadow.
 *
 * Not every binding gets one: parameters of uninstrumented callbacks, imported
 * bindings and destructured patterns do not, and reading a shadow that was
 * never declared is a ReferenceError rather than a missing label.
 */
export class ShadowRegistry {
  private readonly declared = new Set<string>();

  private key(scope: Scope, name: string): string {
    return `${scope.uid}:${name}`;
  }

  declare(scope: Scope, name: string): void {
    this.declared.add(this.key(scope, name));
  }

  /** Walks the scope chain, because a shadow is visible wherever its binding is. */
  has(path: NodePath<t.Node>, name: string): boolean {
    const binding = path.scope.getBinding(name);
    if (binding === undefined) return false;
    return this.declared.has(this.key(binding.scope, name));
  }
}
