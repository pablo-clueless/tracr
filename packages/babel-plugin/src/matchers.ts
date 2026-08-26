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
 * Whether a read matches one declared source path.
 *
 * A leading `*.` stands for exactly one identifier. DOM event sources need it:
 * the binding is named by whoever wrote the handler, so the same source arrives
 * as `event.target.value` by hand, `$event.target.value` from a compiled Vue
 * template, and `e.target.value` from most React code. Matching those by
 * literal root name would mean declaring every spelling anyone might pick.
 *
 * One segment, not a suffix match: `*.target.value` must not quietly claim
 * `form.state.target.value`.
 */
const matchesPath = (path: string, specPath: string): boolean => {
  if (!specPath.startsWith("*.")) {
    return path === specPath || path.startsWith(`${specPath}.`);
  }

  const tail = specPath.slice(2);
  const dot = path.indexOf(".");
  if (dot === -1) return false;

  const rest = path.slice(dot + 1);
  return rest === tail || rest.startsWith(`${tail}.`);
};

/**
 * A declared source taints everything reachable underneath it: declaring
 * `req.body` must make `req.body.name` an origin too. The longest declared
 * prefix wins, so a more specific declaration can override a broader one.
 */
export const matchSource = (path: string, sources: SourceSpec[]): SourceMatch | null => {
  let best: SourceMatch | null = null;

  sources.forEach((spec, sourceId) => {
    if (!matchesPath(path, spec.path)) return;
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
