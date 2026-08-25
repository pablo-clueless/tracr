import { createServer, type Server } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@msgpack/msgpack";

import { EventTag, FrameType, PROTOCOL_VERSION } from "@pablo_clueless/protocol";
import { nodeTransport } from "../src/transport-node.js";

const hello = {
  runId: 1,
  procId: 1,
  language: "js",
  platform: "node",
  protocolVersion: PROTOCOL_VERSION,
} as const;

// Windows has no unix sockets; named pipes are the same API surface in node.
const socketPath = (): string =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\tracr-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : join(tmpdir(), `tracr-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const listen = (path: string, onFrame: (frame: Uint8Array) => void): Promise<Server> =>
  new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const server = createServer((conn) => {
      conn.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const len = buffer.readUInt32BE(0);
          if (buffer.length < 4 + len) break;
          onFrame(new Uint8Array(buffer.subarray(4, 4 + len)));
          buffer = buffer.subarray(4 + len);
        }
      });
    });
    server.listen(path, () => resolve(server));
  });

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("nodeTransport", () => {
  const servers: Server[] = [];
  const cleanupPaths: string[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await Promise.all(cleanupPaths.map((p) => rm(p, { force: true }).catch(() => {})));
  });

  const track = async (path: string): Promise<unknown[]> => {
    const frames: unknown[] = [];
    servers.push(await listen(path, (frame) => frames.push(decode(frame))));
    if (!process.platform.startsWith("win")) cleanupPaths.push(path);
    return frames;
  };

  it("delivers a hello frame then batch frames over the socket", async () => {
    const path = socketPath();
    const frames = await track(path);

    const transport = nodeTransport({ path });
    await transport.open(hello);
    transport.send([[EventTag.Sink, 42, 7, 3]], 2);
    await settle();
    await transport.close();

    expect(frames.length).toBe(2);
    expect(frames[0]).toEqual([FrameType.Hello, PROTOCOL_VERSION, 1, 1, "js", "node"]);
    expect(frames[1]).toEqual([FrameType.Batch, [[EventTag.Sink, 42, 7, 3]], 2]);
  });

  it("queues sends made before open and flushes them once connected", async () => {
    const path = socketPath();
    const frames = await track(path);

    const transport = nodeTransport({ path });
    transport.send([[EventTag.Flow, 1, 2, 5]], 0);
    await transport.open(hello);
    await settle();
    await transport.close();

    expect(frames.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects open when no daemon is listening", async () => {
    const deadPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\tracr-nonexistent-${process.pid}`
        : join(tmpdir(), "tracr-definitely-not-listening.sock");
    const transport = nodeTransport({ path: deadPath, retryMs: 50 });
    await expect(transport.open(hello)).rejects.toThrow();
  });
});
