import type * as t from "@babel/types";
import type { SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

/**
 * Renders a static member chain as a dotted path, e.g. `req.body.name`.
 * Returns null for anything dynamic, because a path we cannot read statically
 * is a path we must not claim to have matched.
 */
export const dottedPath = (node: t.Node): string | null => {
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "ThisExpression":
      return "this";
    case "MemberExpression": {
      const object = dottedPath(node.object);
      if (object === null) return null;

      if (!node.computed && node.property.type === "Identifier") {
        return `${object}.${node.property.name}`;
      }
      if (node.computed && node.property.type === "StringLiteral") {
        return `${object}.${node.property.value}`;
      }
      return null;
    }
    default:
      return null;
  }
};

export interface SourceMatch {
  sourceId: number;
  spec: SourceSpec;
}

/**
 * A declared source taints everything reachable underneath it: declaring
 * `req.body` must make `req.body.name` an origin too. The longest declared
 * prefix wins, so a more specific declaration can override a broader one.
 */
export const matchSource = (path: string, sources: SourceSpec[]): SourceMatch | null => {
  let best: SourceMatch | null = null;

  sources.forEach((spec, sourceId) => {
    if (path !== spec.path && !path.startsWith(`${spec.path}.`)) return;
    if (best === null || spec.path.length > best.spec.path.length) {
      best = { sourceId, spec };
    }
  });

  return best;
};

export interface SinkMatch {
  sinkId: number;
  spec: SinkSpec;
}

/** Sinks match the callee exactly: `query` is a sink, `query.build` is not. */
export const matchSink = (path: string, sinks: SinkSpec[]): SinkMatch | null => {
  const sinkId = sinks.findIndex((spec) => spec.path === path);
  return sinkId === -1 ? null : { sinkId, spec: sinks[sinkId] as SinkSpec };
};

/** Which argument positions of a sink call carry taint that matters. */
export const sinkArgs = (spec: SinkSpec, argCount: number): number[] =>
  spec.args === undefined || spec.args.length === 0
    ? Array.from({ length: argCount }, (_, i) => i)
    : spec.args.filter((i) => i < argCount);
