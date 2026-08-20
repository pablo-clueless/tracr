import type { NodePath } from "@babel/traverse";
import type * as BabelTypes from "@babel/types";
import type * as t from "@babel/types";
import { CombineOp, type SiteId } from "@pablo_clueless/protocol";

import { dottedPath, matchSource } from "./matchers.js";
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
    if (this.isUntainted(left) && this.isUntainted(right)) return this.untainted();
    if (this.isUntainted(left)) return right;
    if (this.isUntainted(right)) return left;
    return this.call("union", [left, right, this.ctx.types.numericLiteral(site)]);
  }

  combine(op: CombineOp, site: SiteId, parents: t.Expression[]): t.Expression {
    const live = parents.filter((p) => !this.isUntainted(p));
    if (live.length === 0) return this.untainted();
    if (live.length === 1) return live[0] as t.Expression;
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
        return this.union(left, right, this.site(node));
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
        return this.combine(CombineOp.Template, this.site(node), parts);
      }

      // Only correct when the shadow is evaluated immediately after the call,
      // which is what the declaration and argument rewrites guarantee.
      case "CallExpression":
      case "NewExpression":
        return this.call("takeReturn", []);

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
          types.numericLiteral(this.site(node)),
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
