import { describe, expect, it } from "vitest";
import { decode } from "@msgpack/msgpack";

import { EventTag, FrameType, PROTOCOL_VERSION } from "@pablo_clueless/protocol";

import { wsTransport, type WebSocketLike } from "../src/transport-ws.js";

const hello = {
  runId: 1,
  procId: 1,
  language: "js",
  platform: "browser",
  protocolVersion: PROTOCOL_VERSION,
} as const;

interface FakeSocket extends WebSocketLike {
  serverOpen(): void;
  serverClose(): void;
  readonly sent: Uint8Array[];
}

let created: FakeSocket[] = [];

/** Fresh socket per connection attempt, recorded for test assertions. */
const fakeFactory = (): FakeSocket => {
  const socket: FakeSocket = {
    binaryType: "",
    readyState: 0,
    onopen: null,
    onclose: null,
    onerror: null,
    sent: [],
    send(data) {
      socket.sent.push(data);
    },
    close() {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      queueMicrotask(() => socket.onclose?.());
    },
    serverOpen() {
      if (socket.readyState !== 0) return;
      socket.readyState = 1;
      queueMicrotask(() => socket.onopen?.());
    },
    serverClose() {
      socket.close();
    },
  };
  created.push(socket);
  return socket;
};

const last = (): FakeSocket => created[created.length - 1] as FakeSocket;

const settle = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("wsTransport", () => {
  it("sends hello on open, then batch frames", async () => {
    created = [];
    const transport = wsTransport({ url: "ws://localhost/test", factory: fakeFactory });

    const opened = transport.open(hello);
    const socket = last();
    socket.serverOpen();
    await opened;

    transport.send([[EventTag.Sink, 9, 4, 1]], 0);
    expect(socket.sent).toHaveLength(2);
    expect(decode(socket.sent[0]!)).toEqual([
      FrameType.Hello,
      PROTOCOL_VERSION,
      1,
      1,
      "js",
      "browser",
    ]);
    expect(decode(socket.sent[1]!)).toEqual([FrameType.Batch, [[EventTag.Sink, 9, 4, 1]], 0]);

    await transport.close();
  });

  it("buffers sends made before open and flushes them after", async () => {
    created = [];
    const transport = wsTransport({ url: "ws://localhost/test", factory: fakeFactory });

    const opened = transport.open(hello);
    const socket = last();
    transport.send([[EventTag.Flow, 1, 2, 5]], 0);
    expect(socket.sent).toHaveLength(0);
    socket.serverOpen();
    await opened;
    expect(socket.sent).toHaveLength(2);

    await transport.close();
  });

  it("rejects open when the daemon never accepts", async () => {
    created = [];
    const transport = wsTransport({
      url: "ws://localhost/refused",
      retryMs: 20,
      factory: () => {
        const socket = fakeFactory();
        queueMicrotask(() => socket.serverClose());
        return socket;
      },
    });
    await expect(transport.open(hello)).rejects.toThrow("not reachable");
  });

  it("reconnects after a drop and replays nothing twice", async () => {
    created = [];
    const transport = wsTransport({
      url: "ws://localhost/test",
      retryMs: 5,
      factory: fakeFactory,
    });
    const opened = transport.open(hello);
    const first = last();
    first.serverOpen();
    await opened;

    first.serverClose();
    await settle(30);
    const second = last();
    expect(second).not.toBe(first);
    second.serverOpen();

    transport.send([[EventTag.Sink, 3, 2, 8]], 0);
    expect(second.sent.filter((f) => decode(f)[0] === FrameType.Batch)).toHaveLength(1);
    expect(decode(second.sent.at(-1)!)).toEqual([FrameType.Batch, [[3, 3, 2, 8]], 0]);

    await transport.close();
  });
});
