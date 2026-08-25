import { connect, type Socket } from "node:net";

import { frameStream } from "./msgpack.js";
import { PendingQueue } from "./pending-queue.js";
import type { Transport } from "./transport.js";
import { encodeBatch, encodeHello } from "./encode.js";

export interface NodeTransportOptions {
  /** Unix socket path, or a `\\.\pipe\` name on Windows. */
  path: string;
  /** Frames buffered while reconnecting before drops are counted. */
  pendingCapacity?: number;
  /** Milliseconds between reconnect attempts. */
  retryMs?: number;
}

const DEFAULT_PENDING = 1024;
const DEFAULT_RETRY_MS = 500;

/**
 * Node agent transport. MessagePack frames over the daemon's unix socket
 * (named pipe on Windows). Reconnects with fixed backoff while running; loss
 * during gaps is folded into the next batch's drop count.
 */
export const nodeTransport = (options: NodeTransportOptions): Transport => {
  const pendingCapacity = options.pendingCapacity ?? DEFAULT_PENDING;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  let socket: Socket | null = null;
  let running = false;
  let connecting = false;
  const queue = new PendingQueue<Uint8Array>(pendingCapacity);

  const write = (frame: Uint8Array): boolean => {
    if (socket === null || !socket.writable) return false;
    socket.write(frameStream(frame));
    return true;
  };

  const attach = (s: Socket): void => {
    s.setNoDelay(true);
    s.unref?.();
  };

  const flushQueue = (): void => {
    const { items, dropped } = queue.drainInto(0);
    if (dropped > 0) {
      // Loss while disconnected rides out as its own batch.
      write(encodeBatch([], dropped));
    }
    for (const frame of items) write(frame);
  };

  const reconnect = (): void => {
    if (!running || connecting || socket !== null) return;
    connecting = true;
    const attempt = connect(options.path, () => {
      connecting = false;
      socket = attempt;
      attach(attempt);
      flushQueue();
    });
    attempt.on("error", () => {});
    attempt.once("close", () => {
      connecting = false;
      if (socket === attempt) socket = null;
      if (running) setTimeout(reconnect, retryMs).unref?.();
    });
  };

  return {
    async open(hello) {
      if (running) throw new Error("nodeTransport is already open");
      running = true;
      await new Promise<void>((resolve, reject) => {
        let established = false;
        const attempt = connect(options.path, () => {
          clearTimeout(fail);
          established = true;
          socket = attempt;
          attach(attempt);
          write(encodeHello(hello));
          flushQueue();
          resolve();
        });
        const fail = setTimeout(() => {
          attempt.destroy();
          reject(new Error(`tracr daemon not reachable at ${options.path}`));
        }, 2000);
        attempt.on("error", (err) => {
          clearTimeout(fail);
          if (!established) reject(err);
        });
        attempt.once("close", () => {
          if (socket === attempt) socket = null;
          // A rejected open must not leave a reconnect loop behind.
          if (running && established) setTimeout(reconnect, retryMs).unref?.();
        });
      });
    },

    send(batch, dropped) {
      const frame = encodeBatch(batch, dropped);
      if (!write(frame)) queue.push(frame);
    },

    async close() {
      running = false;
      const s = socket;
      socket = null;
      if (s === null) return;
      await new Promise<void>((resolve) => {
        s.once("close", resolve);
        s.end();
      });
    },
  };
};
