import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_SOURCE, UNTAINTED, sinkIdOf, sourceIdOf } from "@pablo_clueless/protocol";

import { install } from "../src/runtime.js";
import {
  HEADER,
  adoptRemoteTaint,
  decodeLabels,
  encodeLabels,
  installFetchPropagation,
  taintIncoming,
} from "../src/propagate.js";

/**
 * The deliberate partial in cross-process taint: a browser→API trace should not
 * *visibly* die at the network boundary.
 *
 * The header names internal ids, so most of what matters here is restraint —
 * what it refuses to attach, and to whom.
 */

const FETCH_SINK = 7;
const SITE = 42;

const setup = () => {
  const runtime = install({ transport: undefined });
  const seen: { url: string; headers: Headers }[] = [];

  const target = {
    origin: "https://app.example",
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, headers: new Headers(init?.headers ?? []) });
      return new Response("{}");
    }) as unknown as typeof fetch,
  };

  const uninstall = installFetchPropagation({
    runtime,
    sinkId: FETCH_SINK,
    runId: 1,
    procId: 99,
    target,
    allowHosts: ["api.example"],
  });

  return { runtime, seen, uninstall };
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("encode and decode", () => {
  it("round-trips a label", () => {
    expect(decodeLabels(encodeLabels(1, 99, 5))).toEqual({ runId: 1, procId: 99, label: 5 });
  });

  it("refuses anything malformed rather than throwing", () => {
    // The value arrived over the network. A caller must not be able to break a
    // server by sending a bad one.
    for (const bad of ["", "1:2", "1:2:3:4", "a:b:c", "-1:2:3", "1:2:x", null, undefined]) {
      expect(decodeLabels(bad)).toBeNull();
    }
  });

  it("refuses an untainted label", () => {
    // Nothing to propagate, and a header saying so is noise on the wire.
    expect(decodeLabels(encodeLabels(1, 99, UNTAINTED))).toBeNull();
  });
});

describe("outgoing requests", () => {
  it("tags a request carrying a tainted value", async () => {
    const { runtime, seen, uninstall } = setup();
    cleanup = uninstall;

    runtime.sink(FETCH_SINK, SITE, 5);
    await fetch("/users");

    expect(decodeLabels(seen[0]?.headers.get(HEADER))).toEqual({
      runId: 1,
      procId: 99,
      label: 5,
    });
  });

  it("leaves an untainted request alone", async () => {
    const { seen, uninstall } = setup();
    cleanup = uninstall;

    await fetch("/health");

    expect(seen[0]?.headers.get(HEADER)).toBeNull();
  });

  it("does not tag a cross-origin request", async () => {
    // The header names internal ids; a third party has no business receiving
    // them, and the application talks to third parties.
    const { runtime, seen, uninstall } = setup();
    cleanup = uninstall;

    runtime.sink(FETCH_SINK, SITE, 5);
    await fetch("https://analytics.vendor/collect");

    expect(seen[0]?.headers.get(HEADER)).toBeNull();
  });

  it("tags a host that was named explicitly", async () => {
    const { runtime, seen, uninstall } = setup();
    cleanup = uninstall;

    runtime.sink(FETCH_SINK, SITE, 5);
    await fetch("https://api.example/users");

    expect(seen[0]?.headers.get(HEADER)).not.toBeNull();
  });

  it("spends a sink hit on one request only", async () => {
    // The label is a side channel read in the same tick. Leaving it behind
    // would tag whichever request happened to come next.
    const { runtime, seen, uninstall } = setup();
    cleanup = uninstall;

    runtime.sink(FETCH_SINK, SITE, 5);
    await fetch("/first");
    await fetch("/second");

    expect(seen[0]?.headers.get(HEADER)).not.toBeNull();
    expect(seen[1]?.headers.get(HEADER)).toBeNull();
  });

  it("ignores a sink that is not the one being propagated", async () => {
    const { runtime, seen, uninstall } = setup();
    cleanup = uninstall;

    runtime.sink(FETCH_SINK + 1, SITE, 5);
    await fetch("/users");

    expect(seen[0]?.headers.get(HEADER)).toBeNull();
  });

  it("keeps the caller's own headers", async () => {
    const { runtime, seen, uninstall } = setup();
    cleanup = uninstall;

    runtime.sink(FETCH_SINK, SITE, 5);
    await fetch("/users", { headers: { "content-type": "application/json" } });

    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(seen[0]?.headers.get(HEADER)).not.toBeNull();
  });

  it("restores the original fetch when uninstalled", async () => {
    const before = globalThis.fetch;
    const { uninstall } = setup();

    uninstall();

    expect(globalThis.fetch).toBe(before);
  });
});

describe("incoming requests", () => {
  const NETWORK_SOURCE = 3;
  const HANDLER_SITE = 11;

  const headers = (label: number) => ({ [HEADER]: encodeLabels(1, 99, label) });

  it("picks up a request that arrived tainted", () => {
    const runtime = install({ transport: undefined });

    const adopted = adoptRemoteTaint({
      runtime,
      sourceId: NETWORK_SOURCE,
      site: HANDLER_SITE,
      headers: headers(5),
    });

    expect(adopted?.label).not.toBe(UNTAINTED);
    expect(adopted?.remote).toEqual({ runId: 1, procId: 99, label: 5 });
  });

  it("starts a fresh local chain rather than reusing the remote label", () => {
    // The remote label was minted in another process and means nothing here.
    // Treating it as local would silently merge unrelated provenance.
    const runtime = install({ transport: undefined });

    const adopted = adoptRemoteTaint({
      runtime,
      sourceId: NETWORK_SOURCE,
      site: HANDLER_SITE,
      headers: headers(5000),
    });

    expect(adopted?.label).not.toBe(5000);
  });

  it("anchors to the request so taint survives framework frames", () => {
    // Express hands the handler an object it built; a call-scoped label dies
    // on the way. The object is what carries taint across that gap.
    const runtime = install({ transport: undefined });
    const request = { body: { name: "ada" } };

    const adopted = adoptRemoteTaint({
      runtime,
      sourceId: NETWORK_SOURCE,
      site: HANDLER_SITE,
      headers: headers(5),
      target: request,
    });

    expect(runtime.readSelf(request)).toBe(adopted?.label);
  });

  it("treats a request with no header as ordinary", () => {
    const runtime = install({ transport: undefined });

    expect(
      adoptRemoteTaint({
        runtime,
        sourceId: NETWORK_SOURCE,
        site: HANDLER_SITE,
        headers: {},
      }),
    ).toBeNull();
  });

  it("treats a malformed header as no header at all", () => {
    // Attacker-controlled input. It must not taint, and must not throw.
    const runtime = install({ transport: undefined });

    expect(
      adoptRemoteTaint({
        runtime,
        sourceId: NETWORK_SOURCE,
        site: HANDLER_SITE,
        headers: { [HEADER]: "nonsense" },
      }),
    ).toBeNull();
  });

  it("reads a Headers object as well as Node's plain bag", () => {
    const runtime = install({ transport: undefined });

    const adopted = adoptRemoteTaint({
      runtime,
      sourceId: NETWORK_SOURCE,
      site: HANDLER_SITE,
      headers: new Headers({ [HEADER]: encodeLabels(1, 99, 5) }),
    });

    expect(adopted?.remote.label).toBe(5);
  });

  it("takes the first value when a proxy duplicated the header", () => {
    const runtime = install({ transport: undefined });

    const adopted = adoptRemoteTaint({
      runtime,
      sourceId: NETWORK_SOURCE,
      site: HANDLER_SITE,
      headers: { [HEADER]: [encodeLabels(1, 99, 5), encodeLabels(2, 3, 4)] },
    });

    expect(adopted?.remote).toEqual({ runId: 1, procId: 99, label: 5 });
  });
});

describe("middleware", () => {
  const NETWORK_SOURCE = 3;
  const HANDLER_SITE = 11;

  const middleware = (runtime: ReturnType<typeof install>, onAdopt?: (r: unknown) => void) =>
    taintIncoming({ runtime, sourceId: NETWORK_SOURCE, site: HANDLER_SITE, onAdopt });

  it("taints the request and calls next", () => {
    const runtime = install({ transport: undefined });
    const request = { headers: { [HEADER]: encodeLabels(1, 99, 5) } };
    let continued = false;

    middleware(runtime)(request, {}, () => {
      continued = true;
    });

    expect(continued).toBe(true);
    expect(runtime.readSelf(request)).not.toBe(UNTAINTED);
  });

  it("always calls next, header or not", () => {
    // Swallowing a request would take the application down with the tracer.
    const runtime = install({ transport: undefined });
    let continued = 0;

    middleware(runtime)({ headers: {} }, {}, () => (continued += 1));
    middleware(runtime)({ headers: { [HEADER]: "junk" } }, {}, () => (continued += 1));

    expect(continued).toBe(2);
  });

  it("reports what the other side claimed", () => {
    const runtime = install({ transport: undefined });
    const seen: unknown[] = [];

    middleware(runtime, (r) => seen.push(r))(
      { headers: { [HEADER]: encodeLabels(4, 5, 6) } },
      {},
      () => {},
    );

    expect(seen).toEqual([{ runId: 4, procId: 5, label: 6 }]);
  });

  it("leaves an ordinary request untainted", () => {
    const runtime = install({ transport: undefined });
    const request = { headers: {} };

    middleware(runtime)(request, {}, () => {});

    expect(runtime.readSelf(request)).toBe(UNTAINTED);
  });
});

describe("id lookup", () => {
  const sinks = [
    { id: "dom.innerHTML", module: "*", path: "Element.innerHTML" },
    { id: "fetch.body", module: "*", path: "fetch" },
  ];

  it("finds a spec by its declared id", () => {
    expect(sinkIdOf(sinks, "fetch.body")).toBe(1);
  });

  it("reports a missing spec rather than pointing at index zero", () => {
    // Silently returning 0 would propagate under whatever sink happens to be
    // first, tagging the wrong calls.
    expect(sinkIdOf(sinks, "nope")).toBe(-1);
  });

  it("declares a network source that names nothing in the source code", () => {
    // It exists to occupy an index; the transform must never match it.
    expect(NETWORK_SOURCE.id).toBe("tracr.network");
    expect(sourceIdOf([NETWORK_SOURCE], "tracr.network")).toBe(0);
  });
});
