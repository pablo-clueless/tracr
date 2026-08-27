import { UNTAINTED, type Label } from "@pablo_clueless/protocol";
import type { SiteId } from "@pablo_clueless/protocol";

import type { TracrRuntime } from "./runtime.js";

/**
 * `x-tracr-labels` on an instrumented `fetch`.
 *
 * # What this is and is not
 *
 * Full cross-process taint is a non-goal. This is the deliberate partial: a
 * browser→API trace should not *visibly* die at the network boundary, so the
 * request carries enough for the receiving side to say "this arrived tainted,
 * from that process, derived from that label". The server does not reconstruct
 * the browser's chain, and must not pretend to.
 *
 * # Off unless asked
 *
 * The header names internal ids. Attaching it to every request would put them
 * on the wire to whatever host the application talks to, including third
 * parties that have nothing to do with this tool. So it is opt-in, and even
 * then same-origin only unless a host is named explicitly.
 */

export const HEADER = "x-tracr-labels";

export interface PropagationOptions {
  runtime: TracrRuntime;
  /** The sink whose label rides along — normally `fetch.body`. */
  sinkId: number;
  runId: number;
  procId: number;
  /** Hosts other than this origin that may receive the header. */
  allowHosts?: string[];
  /** Injectable for tests, and for a runtime whose `fetch` is not global. */
  target?: { fetch: typeof fetch; origin: string };
}

/** `runId:procId:label` — meaningless without the daemon that minted it. */
export const encodeLabels = (runId: number, procId: number, label: Label): string =>
  `${String(runId)}:${String(procId)}:${String(label)}`;

export interface PropagatedLabels {
  runId: number;
  procId: number;
  label: Label;
}

/**
 * Parses a header a request arrived with.
 *
 * Returns `null` for anything malformed rather than throwing: the value came
 * from the network and a caller must never be able to break a server by
 * sending a bad one.
 */
export const decodeLabels = (value: string | null | undefined): PropagatedLabels | null => {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;

  const numbers = parts.map((part) => Number(part));
  if (!numbers.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;

  const [runId, procId, label] = numbers as [number, number, number];
  if (label === UNTAINTED) return null;

  return { runId, procId, label };
};

const sameOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    // A URL that will not parse is one we cannot vouch for.
    return false;
  }
};

/**
 * Wraps `fetch` so a tainted request carries its label. Returns an uninstall.
 */
export const installFetchPropagation = (options: PropagationOptions): (() => void) => {
  // `location` is absent in Node, so an origin has to be supplied there.
  const host = globalThis as typeof globalThis & { location?: { origin?: string } };
  const target = options.target ?? {
    fetch: host.fetch.bind(host),
    origin: host.location?.origin ?? "",
  };
  const allowed = new Set(options.allowHosts ?? []);

  const mayTag = (url: string): boolean => {
    if (sameOrigin(url, target.origin)) return true;
    try {
      return allowed.has(new URL(url, target.origin || undefined).host);
    } catch {
      return false;
    }
  };

  const wrapped: typeof fetch = async (input, init) => {
    // Read unconditionally: leaving a stale label behind would tag whichever
    // request happened to come next.
    const label = options.runtime.takeLastSink(options.sinkId);

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (label === UNTAINTED || !mayTag(url)) return target.fetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : []));
    headers.set(HEADER, encodeLabels(options.runId, options.procId, label));
    return target.fetch(input, { ...init, headers });
  };

  const previous = globalThis.fetch;
  globalThis.fetch = wrapped;
  return () => {
    globalThis.fetch = previous;
  };
};

/** Headers as a browser gives them, or as Node hands them to a server. */
export type IncomingHeaders = Headers | Record<string, string | string[] | undefined>;

const headerValue = (headers: IncomingHeaders): string | null => {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(HEADER);

  // Node lowercases incoming header names; a proxy may not have.
  const bag = headers as Record<string, string | string[] | undefined>;
  const raw = bag[HEADER] ?? bag[HEADER.toUpperCase()];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
};

export interface AdoptOptions {
  runtime: TracrRuntime;
  /**
   * The declared source standing for "arrived tainted from another process".
   *
   * A distinct source on purpose: the value really is tainted, but its history
   * happened somewhere this process cannot see, and a chain that started at a
   * local read would be a fabrication.
   */
  sourceId: number;
  site: SiteId;
  headers: IncomingHeaders;
  /**
   * Anchored to this object, normally the request. Object-anchored taint is
   * what survives the uninstrumented framework frames between here and the
   * handler; a call-scoped label would not.
   */
  target?: object;
}

export interface AdoptedTaint {
  label: Label;
  /**
   * What the other side said. Returned rather than recorded: the DAG has no
   * honest place for a label minted in a different process, and inventing the
   * remote steps is exactly what this must not do. Useful for a log, or for a
   * person correlating two runs by eye.
   */
  remote: PropagatedLabels;
}

/**
 * Picks up a request that arrived carrying `x-tracr-labels`.
 *
 * Returns `null` when there is no usable header, so a caller can treat an
 * ordinary request as ordinary.
 */
export const adoptRemoteTaint = (options: AdoptOptions): AdoptedTaint | null => {
  const remote = decodeLabels(headerValue(options.headers));
  if (remote === null) return null;

  const label = options.runtime.origin(options.sourceId, options.site);
  if (options.target !== undefined) options.runtime.anchorSelf(options.target, label);
  return { label, remote };
};

/** The shape a connect-style framework hands a middleware. */
export interface TaintableRequest {
  headers: IncomingHeaders;
}

/**
 * Middleware that picks up an incoming request's propagated taint.
 *
 * Framework-agnostic on purpose: Express, Connect and Fastify all call a
 * `(req, res, next)` and this needs nothing else from them. It anchors to the
 * request object, which is what survives the framework frames between here and
 * the handler.
 */
export const taintIncoming = (options: {
  runtime: TracrRuntime;
  sourceId: number;
  site: SiteId;
  /** Called with what the other side claimed, for a log or a correlation id. */
  onAdopt?: (remote: PropagatedLabels) => void;
}) => {
  return <Req extends TaintableRequest>(request: Req, _response: unknown, next: () => void) => {
    const adopted = adoptRemoteTaint({
      runtime: options.runtime,
      sourceId: options.sourceId,
      site: options.site,
      headers: request.headers,
      target: request,
    });
    if (adopted !== null) options.onAdopt?.(adopted.remote);
    next();
  };
};
