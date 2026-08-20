import type { NodePath } from "@babel/traverse";
import type { PluginObj, PluginPass } from "@babel/core";
import type * as BabelTypes from "@babel/types";
import type * as t from "@babel/types";
import { CombineOp } from "@pablo_clueless/protocol";

import { LabelBuilder } from "./labels.js";
import { ShadowRegistry, shadowName } from "./shadow.js";
import { dottedPath, matchSink, sinkArgs } from "./matchers.js";
import { resolveOptions, type TracrPluginOptions } from "./options.js";
import { SiteTableBuilder } from "./site-table.js";

export interface TracrState {
  options: TracrPluginOptions;
  sites: SiteTableBuilder;
  shadows: ShadowRegistry;
  labels: LabelBuilder;
  /** Nodes this pass has already rewritten, so re-traversal does not recurse. */
  done: WeakSet<t.Node>;
}

export interface TracrPass extends PluginPass {
  tracr: TracrState;
}

interface BabelApi {
  types: typeof BabelTypes;
  assertVersion(range: number): void;
}

const containsCall = (node: t.Node): boolean => {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    const node = n as t.Node;
    if (typeof node.type !== "string") return;
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      found = true;
      return;
    }
    // Do not descend into nested functions: their calls run later, not now.
    if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionDeclaration"
    ) {
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      walk((node as unknown as Record<string, unknown>)[key]);
    }
  };
  walk(node);
  return found;
};

/**
 * Build order:
 *   1. declarations   `let x = e` -> `let x = e, x$t = <label of e>`
 *   2. object anchoring, so taint survives uninstrumented frames
 *   3. binary ops     value unchanged, taint is a union, short-circuit on 0
 *   4. assignment propagation
 *   5. call args      side channel set immediately before the call
 *   6. returns
 *
 * Steps 7-9 (template literals beyond the simple case, destructuring, spread,
 * builtin summaries) are Phase 1.
 */
export const tracrBabelPlugin = (
  api: BabelApi,
  rawOptions: Partial<TracrPluginOptions> = {},
): PluginObj<TracrPass> => {
  api.assertVersion(7);

  const types = api.types;
  const options = resolveOptions(rawOptions);
  const num = (n: number): t.NumericLiteral => types.numericLiteral(n);
  const rtId = (): t.Identifier => types.identifier(options.runtimeGlobal);
  const rtMember = (name: string): t.MemberExpression =>
    types.memberExpression(rtId(), types.identifier(name));

  return {
    name: "tracr",

    pre(file) {
      const filename = (file as { opts?: { filename?: string } }).opts?.filename ?? "<unknown>";
      const sites = new SiteTableBuilder(0);
      const shadows = new ShadowRegistry();

      this.tracr = {
        options,
        sites,
        shadows,
        labels: new LabelBuilder({ types, options, shadows, sites, filename }),
        done: new WeakSet<t.Node>(),
      };
    },

    visitor: {
      // ---------------------------------------------------------------- params
      Function: {
        enter(path) {
          const { labels, shadows, done } = this.tracr;
          if (done.has(path.node)) return;
          done.add(path.node);

          const body = path.node.body;
          if (body.type !== "BlockStatement") return;

          const named = path.node.params
            .map((param, index) => ({ param, index }))
            .filter(
              (entry): entry is { param: t.Identifier; index: number } =>
                entry.param.type === "Identifier",
            );
          if (named.length === 0) return;

          const argsId = path.scope.generateUidIdentifier("args");

          for (const { param } of named) shadows.declare(path.scope, param.name);

          const prelude: t.Statement[] = [
            types.variableDeclaration("const", [
              types.variableDeclarator(
                argsId,
                types.logicalExpression(
                  "||",
                  labels.call("takeArgs", []),
                  types.arrayExpression([]),
                ),
              ),
            ]),
            types.variableDeclaration(
              "let",
              named.map(({ param, index }) =>
                types.variableDeclarator(
                  types.identifier(shadowName(param.name)),
                  types.logicalExpression(
                    "||",
                    types.memberExpression(types.cloneNode(argsId), num(index), true),
                    num(0),
                  ),
                ),
              ),
            ),
          ];

          body.body.unshift(...prelude);
        },
      },

      // ---------------------------------------------------------- declarations
      VariableDeclaration(path) {
        const { labels, shadows, done } = this.tracr;
        if (done.has(path.node)) return;
        done.add(path.node);

        // `for (const x of xs)` takes exactly one declarator.
        const parent = path.parentPath;
        if (parent.isForXStatement() && parent.node.left === path.node) return;

        const extra: t.VariableDeclarator[] = [];

        for (const declarator of path.node.declarations) {
          if (declarator.id.type !== "Identifier") continue;

          const label =
            declarator.init === null || declarator.init === undefined
              ? labels.untainted()
              : labels.labelOf(path, declarator.init);

          shadows.declare(path.scope, declarator.id.name);
          extra.push(
            types.variableDeclarator(types.identifier(shadowName(declarator.id.name)), label),
          );
        }

        if (extra.length === 0) return;
        path.node.declarations.push(...extra);
        path.scope.crawl();
      },

      // ----------------------------------------------------------- assignments
      AssignmentExpression(path) {
        const { labels, shadows, done } = this.tracr;
        if (done.has(path.node)) return;

        const { left, right, operator } = path.node;
        const site = labels.site(path.node);

        let label = labels.labelOf(path, right);
        // `x += e` keeps whatever x already carried.
        if (operator !== "=" && left.type === "Identifier" && shadows.has(path, left.name)) {
          label = labels.union(labels.shadowRef(left.name), label, site);
        }

        if (left.type === "Identifier") {
          if (!shadows.has(path, left.name)) return;
          if (labels.isUntainted(label) && operator === "=") {
            // Still has to clear: the binding may have been tainted before.
            done.add(path.node);
            path.replaceWith(
              types.sequenceExpression([
                path.node,
                types.assignmentExpression("=", labels.shadowRef(left.name), label),
                types.cloneNode(left),
              ]),
            );
            path.skip();
            return;
          }
          done.add(path.node);
          path.replaceWith(
            types.sequenceExpression([
              path.node,
              types.assignmentExpression("=", labels.shadowRef(left.name), label),
              types.cloneNode(left),
            ]),
          );
          path.skip();
          return;
        }

        if (left.type !== "MemberExpression") return;
        if (labels.isUntainted(label)) return;

        const key = labels.propertyKey(left);
        if (key === null || dottedPath(left.object) === null) return;

        // Anchor on the object, which is the taint that survives a trip through
        // uninstrumented framework code.
        const temp = path.scope.generateUidIdentifier("v");
        path.scope.push({ id: types.cloneNode(temp) });

        done.add(path.node);
        path.replaceWith(
          types.sequenceExpression([
            types.assignmentExpression("=", types.cloneNode(temp), right),
            types.assignmentExpression("=", left, types.cloneNode(temp)),
            labels.call("anchor", [left.object as t.Expression, key, label]),
            types.cloneNode(temp),
          ]),
        );
        path.skip();
      },

      // ----------------------------------------------------------- call sites
      CallExpression(path) {
        const { labels, options: opts, done } = this.tracr;
        if (done.has(path.node)) return;

        const callee = path.node.callee;
        if (callee.type === "V8IntrinsicIdentifier") return;
        if (path.node.arguments.some((arg) => arg.type === "SpreadElement")) return;

        const args = path.node.arguments.filter(
          (arg): arg is t.Expression => !arg.type.startsWith("TS") && arg.type !== "SpreadElement",
        );
        if (args.length !== path.node.arguments.length) return;

        const calleePath = dottedPath(callee);
        const sink = calleePath === null ? null : matchSink(calleePath, opts.sinks);

        // Hoist any argument that itself calls, so its label is read after it runs.
        const prelude: t.Expression[] = [];
        const labelRefs: t.Expression[] = [];

        args.forEach((arg, index) => {
          const label = labels.labelOf(path, arg);

          if (!containsCall(arg)) {
            labelRefs.push(label);
            return;
          }

          const valueTemp = path.scope.generateUidIdentifier("a");
          const labelTemp = path.scope.generateUidIdentifier("l");
          path.scope.push({ id: types.cloneNode(valueTemp) });
          path.scope.push({ id: types.cloneNode(labelTemp) });

          prelude.push(types.assignmentExpression("=", types.cloneNode(valueTemp), arg));
          prelude.push(types.assignmentExpression("=", types.cloneNode(labelTemp), label));
          path.node.arguments[index] = types.cloneNode(valueTemp);
          labelRefs.push(types.cloneNode(labelTemp));
        });

        const anyTainted = labelRefs.some((ref) => !labels.isUntainted(ref));
        const discarded = path.parentPath.isExpressionStatement();

        // Untainted call with a consumed result: nothing to do, and doing
        // nothing is the point.
        if (!anyTainted && sink === null && !discarded) return;

        const sequence: t.Expression[] = [...prelude];

        if (anyTainted) {
          sequence.push(
            types.assignmentExpression(
              "=",
              rtMember("argTaint"),
              types.arrayExpression(labelRefs.map((ref) => types.cloneNode(ref))),
            ),
          );
        }

        if (sink !== null) {
          const site = labels.site(path.node, calleePath);
          for (const index of sinkArgs(sink.spec, labelRefs.length)) {
            const ref = labelRefs[index];
            if (ref === undefined || labels.isUntainted(ref)) continue;
            sequence.push(
              labels.call("sink", [num(sink.sinkId), num(site), types.cloneNode(ref)]),
            );
          }
        }

        done.add(path.node);

        if (sequence.length === 0 && !discarded) return;

        sequence.push(path.node);

        // A discarded result leaves retTaint set, which the next takeReturn
        // would misattribute. Clearing costs one call and removes the class.
        if (discarded) sequence.push(labels.call("takeReturn", []));

        path.replaceWith(types.sequenceExpression(sequence));
        path.skip();
      },

      // --------------------------------------------------------------- returns
      ReturnStatement(path) {
        const { labels, done } = this.tracr;
        if (done.has(path.node)) return;
        done.add(path.node);

        const argument = path.node.argument;

        if (argument === null || argument === undefined) {
          path.insertBefore(
            types.expressionStatement(types.assignmentExpression("=", rtMember("retTaint"), num(0))),
          );
          return;
        }

        const label = labels.labelOf(path, argument);
        const temp = path.scope.generateUidIdentifier("r");

        path.replaceWithMultiple([
          types.variableDeclaration("const", [
            types.variableDeclarator(types.cloneNode(temp), argument),
          ]),
          types.expressionStatement(
            types.assignmentExpression("=", rtMember("retTaint"), label),
          ),
          types.returnStatement(types.cloneNode(temp)),
        ]);
      },

      // ------------------------------------------------------------- templates
      TemplateLiteral(path) {
        // Handled by LabelBuilder wherever a template's label is needed; there
        // is nothing to rewrite in the value itself.
        void path;
        void CombineOp;
      },
    },
  };
};

export default tracrBabelPlugin;
