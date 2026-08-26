import { writeFileSync } from "node:fs";

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
  /** Temps the transform introduced. They must never be shadowed themselves. */
  generated: Set<string>;
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

  /** True for anything this transform emitted: shadows and hoisted temps. */
  const isGenerated = (name: string, generated: Set<string>): boolean =>
    name.endsWith("$t") || generated.has(name);

  /** True for `__tracr.anything`, so the transform never rewrites its own calls. */
  const isRuntimeRef = (node: t.Node): boolean => {
    const path = dottedPath(node);
    return path !== null && path.split(".")[0] === options.runtimeGlobal;
  };

  return {
    name: "tracr",

    pre(file) {
      const filename = (file as { opts?: { filename?: string } }).opts?.filename ?? "<unknown>";
      const sites = new SiteTableBuilder(0, options.siteIdBase);
      const shadows = new ShadowRegistry();

      this.tracr = {
        options,
        sites,
        shadows,
        labels: new LabelBuilder({ types, options, shadows, sites, filename }),
        done: new WeakSet<t.Node>(),
        generated: new Set<string>(),
      };
    },

    post(file) {
      const table = this.tracr.sites.build();
      const meta = (file as unknown as { metadata: Record<string, unknown> }).metadata;
      meta.tracr = { siteTable: table };

      // The agent ships only the integer at runtime; this is the side table
      // that turns it back into a file and a line.
      const target = this.tracr.options.siteTableOut;
      if (target !== null) writeFileSync(target, JSON.stringify(table, null, 2));
    },

    visitor: {
      // ---------------------------------------------------------------- params
      Function: {
        enter(path) {
          const { labels, shadows, done } = this.tracr;
          if (done.has(path.node)) return;
          done.add(path.node);

          // `x => expr` has nowhere to put the param prelude and no return
          // statement to carry retTaint. Widening it to a block body is
          // semantically identical and makes both possible.
          if (
            path.node.type === "ArrowFunctionExpression" &&
            path.node.body.type !== "BlockStatement"
          ) {
            path.node.body = types.blockStatement([
              types.returnStatement(path.node.body as t.Expression),
            ]);
          }

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
          this.tracr.generated.add(argsId.name);

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

      // ----------------------------------------------------------------- shims
      /**
       * `import { useState, useEffect } from "react"` becomes
       * `import { useEffect } from "react"; import { useState } from "<via>"`.
       *
       * Only the shimmed names move. Redirecting the whole module would mean
       * the stand-in has to re-export every binding the framework has, forever;
       * splitting the declaration keeps the blast radius to the named hooks.
       *
       * A default import (`import React from "react"`, then `React.useState`)
       * is deliberately left alone — the member call is not an import binding,
       * so there is nothing here to rewrite.
       */
      ImportDeclaration(path) {
        const { options, done } = this.tracr;
        if (done.has(path.node)) return;

        const source = path.node.source.value;
        const applicable = options.shims.filter(
          (shim) => shim.module === source && shim.via !== undefined,
        );
        if (applicable.length === 0) return;

        const via = new Map(applicable.map((shim) => [shim.export, shim.via as string]));
        const moved = new Map<string, t.ImportSpecifier[]>();
        const kept: typeof path.node.specifiers = [];

        for (const specifier of path.node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            kept.push(specifier);
            continue;
          }
          const name =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          const target = via.get(name);
          if (target === undefined) {
            kept.push(specifier);
            continue;
          }
          moved.set(target, [...(moved.get(target) ?? []), specifier]);
        }

        if (moved.size === 0) return;
        done.add(path.node);

        const redirected = [...moved].map(([target, specifiers]) =>
          types.importDeclaration(specifiers, types.stringLiteral(target)),
        );

        if (kept.length === 0) {
          path.replaceWithMultiple(redirected);
          return;
        }
        path.node.specifiers = kept;
        path.insertAfter(redirected);
      },

      // ---------------------------------------------------------- declarations
      VariableDeclaration(path) {
        const { labels, shadows, done, generated } = this.tracr;
        if (done.has(path.node)) return;
        done.add(path.node);

        // `for (const x of xs)` takes exactly one declarator.
        const parent = path.parentPath;
        if (parent.isForXStatement() && parent.node.left === path.node) return;

        // Rebuilt rather than appended to: a destructured pattern needs its
        // initialiser hoisted into a temp *before* the pattern that reads it,
        // and declarators evaluate left to right.
        const rebuilt: t.VariableDeclarator[] = [];
        const extra: t.VariableDeclarator[] = [];

        /**
         * `const [a, b] = expr` becomes
         * `const _d = expr, [a, b] = _d, a$t = readAnchor(_d, 0), b$t = ...`.
         *
         * Element labels come from per-index anchors rather than the container's
         * own label, because a tuple's elements are not interchangeable: a shim
         * that taints `[value, setValue]` means the value, not the setter.
         * `readAnchor` on a primitive is a WeakMap miss, so a non-object
         * initialiser costs one lookup and yields untainted.
         */
        const destructure = (
          declarator: t.VariableDeclarator,
          pattern: t.ArrayPattern,
          into: t.VariableDeclarator[],
        ): t.VariableDeclarator[] => {
          const temp = path.scope.generateUidIdentifier("d");
          generated.add(temp.name);

          const hoisted = types.variableDeclarator(temp, declarator.init as t.Expression);
          declarator.init = types.cloneNode(temp);

          pattern.elements.forEach((element, index) => {
            // Holes and rest elements carry no single label.
            if (element === null || element.type !== "Identifier") return;
            if (isGenerated(element.name, generated)) return;

            shadows.declare(path.scope, element.name);
            into.push(
              types.variableDeclarator(
                types.identifier(shadowName(element.name)),
                labels.call("readAnchor", [types.cloneNode(temp), types.numericLiteral(index)]),
              ),
            );
          });

          return [hoisted, declarator];
        };

        for (const declarator of path.node.declarations) {
          if (declarator.id.type === "ArrayPattern" && declarator.init != null) {
            rebuilt.push(...destructure(declarator, declarator.id, extra));
            continue;
          }

          rebuilt.push(declarator);

          if (declarator.id.type !== "Identifier") continue;
          if (isGenerated(declarator.id.name, generated)) continue;

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
        path.node.declarations = [...rebuilt, ...extra];
      },

      // ----------------------------------------------------------- assignments
      AssignmentExpression(path) {
        const { labels, shadows, done, generated } = this.tracr;
        if (done.has(path.node)) return;

        // Writes the transform emitted: shadow updates, temps, `__tracr.retTaint`.
        if (path.node.left.type === "Identifier" && isGenerated(path.node.left.name, generated))
          return;
        if (isRuntimeRef(path.node.left)) return;

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
          return;
        }

        if (left.type !== "MemberExpression") return;
        if (labels.isUntainted(label)) return;

        const key = labels.propertyKey(left);
        if (key === null || dottedPath(left.object) === null) return;

        // Anchor on the object, which is the taint that survives a trip through
        // uninstrumented framework code.
        const temp = path.scope.generateUidIdentifier("v");
        generated.add(temp.name);
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
      },

      // ----------------------------------------------------------- call sites
      CallExpression(path) {
        const { labels, options: opts, done } = this.tracr;
        if (done.has(path.node)) return;

        const callee = path.node.callee;
        if (callee.type === "V8IntrinsicIdentifier") return;
        if (isRuntimeRef(callee)) return;
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
          this.tracr.generated.add(valueTemp.name);
          this.tracr.generated.add(labelTemp.name);
          path.scope.push({ id: types.cloneNode(valueTemp) });
          path.scope.push({ id: types.cloneNode(labelTemp) });

          prelude.push(types.assignmentExpression("=", types.cloneNode(valueTemp), arg));
          prelude.push(types.assignmentExpression("=", types.cloneNode(labelTemp), label));
          path.node.arguments[index] = types.cloneNode(valueTemp);
          labelRefs.push(types.cloneNode(labelTemp));
        });

        const anyTainted = labelRefs.some((ref) => !labels.isUntainted(ref));
        const discarded = path.parentPath.isExpressionStatement();

        // A builtin is uninstrumented: it never calls takeArgs, so setting the
        // side channel would leave a stale value for the next real call, and it
        // never sets retTaint either.
        const builtin = labels.builtinFor(path.node) !== null;

        // A label expression is not free to evaluate twice: `origin()` interns
        // and emits an event on every call. When both the side channel and a
        // sink report need the same label, it has to be read exactly once.
        if (sink !== null && anyTainted) {
          labelRefs.forEach((ref, index) => {
            if (ref.type === "Identifier" || labels.isUntainted(ref)) return;
            const labelTemp = path.scope.generateUidIdentifier("l");
            this.tracr.generated.add(labelTemp.name);
            path.scope.push({ id: types.cloneNode(labelTemp) });
            prelude.push(types.assignmentExpression("=", types.cloneNode(labelTemp), ref));
            labelRefs[index] = types.cloneNode(labelTemp);
          });
        }

        // Untainted call with a consumed result: nothing to do, and doing
        // nothing is the point.
        if (!anyTainted && sink === null && !discarded) return;
        if (builtin && sink === null && !discarded) return;

        const sequence: t.Expression[] = [...prelude];

        if (anyTainted && !builtin) {
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
            sequence.push(labels.call("sink", [num(sink.sinkId), num(site), types.cloneNode(ref)]));
          }
        }

        done.add(path.node);

        if (sequence.length === 0 && !discarded) return;

        sequence.push(path.node);

        // A discarded result leaves retTaint set, which the next takeReturn
        // would misattribute. Clearing costs one call and removes the class.
        if (discarded && !builtin) sequence.push(labels.call("takeReturn", []));

        path.replaceWith(types.sequenceExpression(sequence));
      },

      // --------------------------------------------------------------- returns
      ReturnStatement(path) {
        const { labels, done } = this.tracr;
        if (done.has(path.node)) return;
        done.add(path.node);

        const argument = path.node.argument;

        if (argument === null || argument === undefined) {
          path.insertBefore(
            types.expressionStatement(
              types.assignmentExpression("=", rtMember("retTaint"), num(0)),
            ),
          );
          return;
        }

        const label = labels.labelOf(path, argument);
        const temp = path.scope.generateUidIdentifier("r");
        this.tracr.generated.add(temp.name);

        // The replacement contains a ReturnStatement of its own; without
        // marking it the visitor would rewrite its own output forever.
        const replacement = types.returnStatement(types.cloneNode(temp));
        done.add(replacement);

        path.replaceWithMultiple([
          types.variableDeclaration("const", [
            types.variableDeclarator(types.cloneNode(temp), argument),
          ]),
          types.expressionStatement(types.assignmentExpression("=", rtMember("retTaint"), label)),
          replacement,
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
