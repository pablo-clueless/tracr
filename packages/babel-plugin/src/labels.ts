import type { NodePath } from "@babel/traverse";
import type * as BabelTypes from "@babel/types";
import type * as t from "@babel/types";
import { CombineOp, type SiteId } from "@pablo_clueless/protocol";

import { dottedPath, matchSource } from "./matchers.js";
import { lookupBuiltin } from "./summaries.js";
import { shadowName, type ShadowRegistry } from "./shadow.js";
import type { SiteTableBuilder } from "./site-table.js";
import type { TracrPluginOptions } from "./options.js";

export interface LabelContext {
  types: typeof BabelTypes;
  options: TracrPluginOptions;
  shadows: ShadowRegistry;
  sites: SiteTableBuilder;
  filename: string;
}

/** Builds the expression that evaluates to a value's label at runtime. */
export class LabelBuilder {
  private readonly ctx: LabelContext;

  constructor(ctx: LabelContext) {
    this.ctx = ctx;
  }

  /** Label 0. Emitted inline so an untainted operand costs a constant, not a call. */
  untainted(): t.NumericLiteral {
    return this.ctx.types.numericLiteral(0);
  }

  isUntainted(node: t.Expression): boolean {
    return node.type === "NumericLiteral" && node.value === 0;
  }

  /** The nearest enclosing function's name, for readable attribution. */
  enclosingName(path: NodePath<t.Node>): string | null {
    const fn = path.getFunctionParent();
    if (fn === null) return null;

    const node = fn.node;
    if ("id" in node && node.id !== null && node.id !== undefined) return node.id.name;

    // `const normalize = (req) => {}` carries its name on the declarator.
    const parent = fn.parentPath;
    if (parent !== null && parent.isVariableDeclarator() && parent.node.id.type === "Identifier") {
      return parent.node.id.name;
    }
    return null;
  }

  site(node: t.Node, fnName: string | null = null): SiteId {
    const loc = node.loc?.start;
    return this.ctx.sites.assign(this.ctx.filename, loc?.line ?? 0, loc?.column ?? 0, fnName);
  }

  /** `__tracr.<method>(...args)` */
  call(method: string, args: t.Expression[]): t.CallExpression {
    const { types } = this.ctx;
    return types.callExpression(
      types.memberExpression(
        types.identifier(this.ctx.options.runtimeGlobal),
        types.identifier(method),
      ),
      args,
    );
  }

  shadowRef(name: string): t.Identifier {
    return this.ctx.types.identifier(shadowName(name));
  }

  /**
   * A union of two labels, folded at build time when either side is statically
   * untainted. Emitting `union(0, 0, site)` would be correct but would put a
   * call on the hot path of every untainted binary op.
   */
  union(left: t.Expression, right: t.Expression, site: SiteId): t.Expression {
    // Folding a half-untainted union would be correct for tracking taint and
    // wrong for the product: `a + b` is a derivation step, and dropping it
    // silently shortens the chain the user came here to read.
    if (this.isUntainted(left) && this.isUntainted(right)) return this.untainted();
    return this.call("union", [left, right, this.ctx.types.numericLiteral(site)]);
  }

  combine(op: CombineOp, site: SiteId, parents: t.Expression[]): t.Expression {
    const live = parents.filter((p) => !this.isUntainted(p));
    if (live.length === 0) return this.untainted();
    // A single tainted parent is still a step: `x.trim()` happened here.
    const { types } = this.ctx;
    return this.call("combine", [
      types.numericLiteral(op),
      types.numericLiteral(site),
      types.arrayExpression(live),
    ]);
  }

  /**
   * The label of an expression.
   *
   * `path` is only used to resolve identifiers against the scope chain; `node`
   * is what actually gets read, so a caller can ask about a node it has already
   * detached from the tree.
   */
  labelOf(path: NodePath<t.Node>, node: t.Expression): t.Expression {
    const { types, options } = this.ctx;

    switch (node.type) {
      case "Identifier":
        return this.ctx.shadows.has(path, node.name) ? this.shadowRef(node.name) : this.untainted();

      case "MemberExpression":
        return this.memberLabel(path, node);

      case "BinaryExpression": {
        if (node.left.type === "PrivateName") return this.untainted();
        const left = this.labelOf(path, node.left);
        const right = this.labelOf(path, node.right);
        return this.union(left, right, this.site(node, this.enclosingName(path)));
      }

      case "LogicalExpression":
        return this.union(
          this.labelOf(path, node.left),
          this.labelOf(path, node.right),
          this.site(node),
        );

      case "ConditionalExpression":
        return this.union(
          this.labelOf(path, node.consequent),
          this.labelOf(path, node.alternate),
          this.site(node),
        );

      case "TemplateLiteral": {
        const parts = node.expressions
          .filter((e): e is t.Expression => !e.type.startsWith("TS"))
          .map((e) => this.labelOf(path, e));
        return this.combine(CombineOp.Template, this.site(node, this.enclosingName(path)), parts);
      }

      // Only correct when the shadow is evaluated immediately after the call,
      // which is what the declaration and argument rewrites guarantee.
      case "CallExpression":
      case "NewExpression": {
        const summary = node.type === "CallExpression" ? this.builtinLabel(path, node) : null;
        return summary ?? this.call("takeReturn", []);
      }

      // A container is only as tainted as what was put in it. Without this a
      // value dies the moment it is passed as `f([x])`.
      case "ArrayExpression": {
        const parts = node.elements
          .filter((e): e is t.Expression => e !== null && e.type !== "SpreadElement")
          .map((e) => this.labelOf(path, e));
        return this.combine(CombineOp.Container, this.site(node, this.enclosingName(path)), parts);
      }

      case "ObjectExpression": {
        const parts = node.properties
          .filter((p): p is t.ObjectProperty => p.type === "ObjectProperty")
          .filter((p) => !p.value.type.startsWith("TS") && p.value.type !== "RestElement")
          .map((p) => this.labelOf(path, p.value as t.Expression));
        return this.combine(CombineOp.Container, this.site(node, this.enclosingName(path)), parts);
      }

      case "AwaitExpression":
        return this.labelOf(path, node.argument);

      case "AssignmentExpression":
        return this.labelOf(path, node.right);

      case "SequenceExpression": {
        const last = node.expressions[node.expressions.length - 1];
        return last === undefined ? this.untainted() : this.labelOf(path, last);
      }

      case "UnaryExpression":
        // `!x` and `typeof x` erase the value; arithmetic coercion does not.
        return node.operator === "-" || node.operator === "+" || node.operator === "~"
          ? this.labelOf(path, node.argument)
          : this.untainted();

      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
        return this.labelOf(path, node.expression);

      default:
        void types;
        void options;
        return this.untainted();
    }
  }

  /**
   * The name of the builtin a callee resolves to, or null. Exposed so the call
   * visitor can tell that a callee cannot consume the argument side channel.
   */
  builtinFor(node: t.CallExpression): ReturnType<typeof lookupBuiltin> {
    const callee = node.callee;
    if (callee.type === "V8IntrinsicIdentifier") return null;

    const full = dottedPath(callee);
    const method =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier"
        ? callee.property.name
        : null;

    return lookupBuiltin(full, method);
  }

  /**
   * Taint dies the moment a value enters an uninstrumented builtin, because
   * `node_modules` and native code are never transformed. The summary table is
   * the substitute: it says which operands reach the result.
   */
  private builtinLabel(path: NodePath<t.Node>, node: t.CallExpression): t.Expression | null {
    const summary = this.builtinFor(node);
    if (summary === null) return null;

    const parents: t.Expression[] = [];

    if (summary.receiver && node.callee.type === "MemberExpression") {
      parents.push(this.labelOf(path, node.callee.object as t.Expression));
    }

    for (const index of summary.args) {
      const arg = node.arguments[index];
      if (arg === undefined || arg.type === "SpreadElement" || arg.type.startsWith("TS")) continue;
      parents.push(this.labelOf(path, arg as t.Expression));
    }

    // `a.trim().toLowerCase()` has both CallExpressions starting at `a`, so
    // attribute each step to its own method name instead.
    const at = node.callee.type === "MemberExpression" ? node.callee.property : node;
    return this.combine(CombineOp.Builtin, this.site(at, this.enclosingName(path)), parents);
  }

  /**
   * A declared source is an origin wherever it is read. Anything else falls back
   * to whatever was anchored on the object, which is the only taint that
   * survives a trip through uninstrumented framework code.
   */
  private memberLabel(path: NodePath<t.Node>, node: t.MemberExpression): t.Expression {
    const { types, options } = this.ctx;

    const full = dottedPath(node);
    if (full !== null) {
      const source = matchSource(full, options.sources);
      if (source !== null) {
        return this.call("origin", [
          types.numericLiteral(source.sourceId),
          types.numericLiteral(this.site(node, this.enclosingName(path))),
        ]);
      }
    }

    const key = this.propertyKey(node);
    if (key === null) return this.untainted();

    // Re-reading the object has to be side-effect free, so this only fires for
    // static identifier chains.
    if (dottedPath(node.object) === null) return this.untainted();

    return this.call("readAnchor", [node.object as t.Expression, key]);
  }

  propertyKey(node: t.MemberExpression): t.Expression | null {
    const { types } = this.ctx;
    if (!node.computed && node.property.type === "Identifier") {
      return types.stringLiteral(node.property.name);
    }
    if (node.computed && node.property.type === "StringLiteral") {
      return types.stringLiteral(node.property.value);
    }
    if (node.computed && node.property.type === "NumericLiteral") {
      return types.stringLiteral(String(node.property.value));
    }
    return null;
  }
}
