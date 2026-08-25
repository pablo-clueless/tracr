import type { AgentHello } from "@pablo_clueless/protocol";

import { encodeBatch, encodeHello } from "./encode.js";
import { PendingQueue } from "./pending-queue.js";
import type { Transport } from "./transport.js";

export interface WsTransportOptions {
  url: string;
  /** Frames buffered while reconnecting before drops are counted. */
  pendingCapacity?: number;
  /** Milliseconds between reconnect attempts. */
  retryMs?: number;
  /**
   * Injectable socket constructor. Browsers provide WebSocket; tests inject a
   * fake instead of standing up a server.
   */
  factory?: (url: string) => WebSocketLike;
}

/** The slice of the DOM WebSocket the transport touches. */
export interface WebSocketLike {
  send(data: Uint8Array): void;
  close(): void;
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

const OPEN = 1;
const DEFAULT_PENDING = 1024;
const DEFAULT_RETRY_MS = 500;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(err: Error): void;
}

const defer = (): Deferred => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Browser agent transport. One MessagePack frame per WS message; message
 * boundaries do the framing, so no length prefix is needed.
 */
export const wsTransport = (options: WsTransportOptions): Transport => {
  const pendingCapacity = options.pendingCapacity ?? DEFAULT_PENDING;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const makeSocket =
    options.factory ??
    ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  let running = false;
  let everConnected = false;
  let current: WebSocketLike | null = null;
  const queue = new PendingQueue<Uint8Array>(pendingCapacity);

  const write = (frame: Uint8Array): boolean => {
    if (current === null || current.readyState !== OPEN) return false;
    current.send(frame);
    return true;
  };

  const flushQueue = (): void => {
    const { items, dropped } = queue.drainInto(0);
    if (dropped > 0) write(encodeBatch([], dropped));
    for (const frame of items) write(frame);
  };

  /**
   * Opens one socket. `hello` is non-null only for the very first connection,
   * where success/failure settles the transport's open().
   */
  const establish = (
    hello: AgentHello | null,
    settle: Deferred | null,
  ): void => {
    const fail = setTimeout(() => {
      socket.close();
      settle?.reject(new Error(`tracr daemon not reachable at ${options.url}`));
    }, 2000);

    const socket = makeSocket(options.url);
    socket.binaryType = "arraybuffer";
    current = socket;

    socket.onopen = () => {
      clearTimeout(fail);
      everConnected = true;
      if (hello !== null) socket.send(encodeHello(hello));
      flushQueue();
      settle?.resolve();
    };
    socket.onclose = () => {
      clearTimeout(fail);
      if (current === socket) current = null;
      if (!everConnected) {
        settle?.reject(new Error(`tracr daemon not reachable at ${options.url}`));
      }
      // A rejected open must not leave a reconnect loop behind.
      if (running && everConnected) setTimeout(reconnect, retryMs);
    };
    socket.onerror = () => {};
  };

  /** Reconnect loop entry point. Sends nothing until the queue drains. */
  const reconnect = (): void => {
    if (!running || current !== null || !everConnected) return;
    establish(null, null);
  };

  return {
    async open(hello) {
      if (running) throw new Error("wsTransport is already open");
      running = true;
      const settle = defer();
      establish(hello, settle);
      await settle.promise;
    },

    send(batch, dropped) {
      const frame = encodeBatch(batch, dropped);
      if (!write(frame)) queue.push(frame);
    },

    async close() {
      running = false;
      const socket = current;
      current = null;
      socket?.close();
    },
  };
};
