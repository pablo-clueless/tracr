import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { existsSync } from "node:fs";

import {
  CombineOp,
  EventTag,
  PROTOCOL_VERSION,
  UpdateTag,
  type AgentEvent,
} from "@pablo_clueless/protocol";
import { wsTransport } from "../src/transport-ws.js";

/**
 * The JavaScript agent against the real Rust daemon.
 *
 * Every layer either side of this boundary has its own tests, and the wire
 * fixtures check that the encoder's bytes decode. What none of them cover is
 * the live path: a socket the transport opened, a daemon process that parsed
 * what came out of it, and a viewer that saw the result. This is the only test
 * that fails if the two sides drift apart at runtime.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const BINARY = join(
  ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "tracr-core.exe" : "tracr-core",
);
const SITES = join(ROOT, "crates", "core", "tests", "fixtures", "sites.json");

/** Sites 1 and 2 sit in `helper`; sites 3, 4 and 5 sit in `handler`. */
const HELPER_SITE = 1;
const HANDLER_SITE = 5;

const freePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });

/** Resolves once the daemon says it is listening, so nothing races the bind. */
const startDaemon = async (port: number): Promise<ChildProcessWithoutNullStreams> => {
  const child = spawn(BINARY, [`127.0.0.1:${port}`, SITES], { stdio: "pipe" });

  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("daemon never reported listening")), 10_000);
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        ready();
      }
    });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`daemon exited early with ${String(code)}`)));
  });

  return child;
};

/** Collects viewer frames, so a test can wait for the one it cares about. */
const viewer = async (port: number) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames: Record<string, unknown>[] = [];

  socket.addEventListener("message", (event: MessageEvent<string>) => {
    frames.push(JSON.parse(event.data) as Record<string, unknown>);
  });

  await new Promise<void>((ready, fail) => {
    socket.addEventListener("open", () => ready(), { once: true });
    socket.addEventListener("error", () => fail(new Error("viewer could not connect")), {
      once: true,
    });
  });

  return {
    socket,
    /**
     * Polls rather than taking the next frame: the daemon ticks on its own
     * clock, so which frame carries a change is a race. Pinning it would make
     * the test flaky rather than strict.
     */
    async waitFor(want: (frame: Record<string, unknown>) => boolean, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = frames.find(want);
        if (found !== undefined) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no frame matched; saw ${JSON.stringify(frames)}`);
    },
  };
};

const hello = {
  runId: 0,
  procId: 4242,
  language: "javascript",
  platform: "browser" as const,
  protocolVersion: PROTOCOL_VERSION,
};

describe("javascript agent against the rust daemon", () => {
  let daemon: ChildProcessWithoutNullStreams | null = null;
  let port = 0;

  beforeAll(() => {
    if (!existsSync(BINARY)) {
      throw new Error(
        `tracr-core not built at ${BINARY}. Run \`cargo build\` first — this test exists to catch the JS and Rust sides drifting, so skipping it silently would defeat the point.`,
      );
    }
  });

  afterEach(async () => {
    const child = daemon;
    daemon = null;
    if (child === null || child.exitCode !== null) return;
    // Waited on, not just signalled: the OS hands the freed port straight back
    // to the next test, and a daemon still holding it would fail to bind.
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill();
    });
  });

  it("hands a fresh viewer the skeleton built from the site table", async () => {
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);

    const skeleton = await ui.waitFor((frame) => frame.tag === 0);

    // One file, two functions, five call sites — the fixture the Babel pass wrote.
    expect((skeleton.nodes as unknown[]).length).toBe(8);
    ui.socket.close();
  });

  it("carries a sink hit from the browser transport to the viewer", async () => {
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);
    await ui.waitFor((frame) => frame.tag === 0);

    const transport = wsTransport({ url: `ws://127.0.0.1:${port}/agent` });
    await transport.open(hello);

    const events: AgentEvent[] = [
      [EventTag.Origin, HELPER_SITE, 1, 0],
      [EventTag.Sink, HANDLER_SITE, 1, 0],
    ];
    transport.send(events, 0);

    const delta = await ui.waitFor(
      (frame) => frame.tag === 1 && (frame.sinks as unknown[]).length > 0,
    );

    // Site 5 is inside `handler`, which is inside src/routes.ts: node 1.
    expect((delta.sinks as { nodeId: number; count: number }[])[0]).toMatchObject({
      nodeId: 1,
      count: 1,
    });
    await transport.close();
    ui.socket.close();
  });

  it("reports a flow between two functions in one file", async () => {
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);
    await ui.waitFor((frame) => frame.tag === 0);

    const transport = wsTransport({ url: `ws://127.0.0.1:${port}/agent` });
    await transport.open(hello);

    transport.send(
      [
        [EventTag.Origin, HELPER_SITE, 1, 0],
        [EventTag.Flow, HELPER_SITE, HANDLER_SITE, 1],
      ],
      0,
    );

    // Both sites live in src/routes.ts, so at file level this never leaves the
    // module and lands on the node rather than on an edge.
    const delta = await ui.waitFor(
      (frame) => frame.tag === 1 && (frame.internal as unknown[]).length > 0,
    );

    expect((delta.internal as { nodeId: number; count: number }[])[0]).toMatchObject({
      nodeId: 1,
      count: 1,
    });
    await transport.close();
    ui.socket.close();
  });

  it("surfaces a drop count the agent admits to", async () => {
    // Silent loss destroys trust faster than being slow, so the number has to
    // survive the whole path rather than being swallowed at a boundary.
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);
    await ui.waitFor((frame) => frame.tag === 0);

    const transport = wsTransport({ url: `ws://127.0.0.1:${port}/agent` });
    await transport.open(hello);
    transport.send([], 17);

    const delta = await ui.waitFor((frame) => frame.tag === 1 && frame.droppedTotal === 17);

    expect(delta.droppedTotal).toBe(17);
    await transport.close();
    ui.socket.close();
  });

  it("switches granularity when the viewer asks", async () => {
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);
    await ui.waitFor((frame) => frame.tag === 0);

    const transport = wsTransport({ url: `ws://127.0.0.1:${port}/agent` });
    await transport.open(hello);
    transport.send(
      [
        [EventTag.Origin, HELPER_SITE, 1, 0],
        [EventTag.Flow, HELPER_SITE, HANDLER_SITE, 1],
      ],
      0,
    );
    await ui.waitFor((frame) => frame.tag === 1 && (frame.internal as unknown[]).length > 0);

    // One level down the two sites are in different functions, and the site
    // table declares no edges, so the crossing is reported as unmapped.
    ui.socket.send(JSON.stringify({ level: 1 }));

    const delta = await ui.waitFor(
      (frame) => frame.tag === 1 && (frame.unmapped as unknown[]).length > 0,
    );

    const crossing = (delta.unmapped as { source: number; target: number }[])[0];
    expect(crossing.source).not.toBe(crossing.target);
    await transport.close();
    ui.socket.close();
  });

  it("answers a viewer asking how a value reached a sink", async () => {
    // The product's whole claim, over the real socket: click a node, get the
    // derivation back to the declared source.
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);
    await ui.waitFor((frame) => frame.tag === UpdateTag.Skeleton);

    const transport = wsTransport({ url: `ws://127.0.0.1:${port}/agent` });
    await transport.open(hello);

    // req.body.name -> trim() -> interpolated -> handed to query().
    const events: AgentEvent[] = [
      [EventTag.Origin, HELPER_SITE, 1, 7],
      [EventTag.Combine, 2, 2, CombineOp.Builtin, [1]],
      [EventTag.Combine, 4, 3, CombineOp.Template, [2]],
      [EventTag.Sink, HANDLER_SITE, 3, 0],
    ];
    transport.send(events, 0);
    await ui.waitFor((frame) => frame.tag === UpdateTag.Delta && (frame.sinks as []).length > 0);

    // Site 5 sits in src/routes.ts, which is node 1.
    ui.socket.send(JSON.stringify({ chain: 1 }));
    const reply = await ui.waitFor((frame) => frame.tag === UpdateTag.Chain);

    const steps = reply.steps as {
      kind: number;
      op: number | null;
      sourceId: number | null;
      nodeId: number | null;
    }[];

    expect(steps).toHaveLength(3);
    // Origin first, so the chain reads the way the value was built.
    expect(steps[0]).toMatchObject({ kind: 0, sourceId: 7 });
    expect(steps[1]?.op).toBe(CombineOp.Builtin);
    expect(steps[2]?.op).toBe(CombineOp.Template);
    expect(reply.truncated).toBe(false);
    // Resolved against the skeleton, so the UI can name a file without asking.
    expect(steps[0]?.nodeId).not.toBeNull();

    await transport.close();
    ui.socket.close();
  });

  it("stays quiet when a node has no sink to explain", async () => {
    port = await freePort();
    daemon = await startDaemon(port);
    const ui = await viewer(port);
    await ui.waitFor((frame) => frame.tag === UpdateTag.Skeleton);

    // Nothing has ever run, so there is no derivation to show. A fabricated
    // empty chain would read as "this value came from nowhere".
    ui.socket.send(JSON.stringify({ chain: 1 }));

    // Short deadline on purpose: the assertion is that nothing arrives, so the
    // wait only has to outlast a tick.
    const answered = await ui
      .waitFor((frame) => frame.tag === UpdateTag.Chain, 500)
      .then(() => true)
      .catch(() => false);
    expect(answered).toBe(false);
    ui.socket.close();
  });
});
