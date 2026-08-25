import { PROTOCOL_VERSION } from "@pablo_clueless/protocol";

import { install, type RuntimeOptions, type TracrRuntime } from "./runtime.js";
import { nodeTransport } from "./transport-node.js";

let warned = false;
let started = false;

const warnOnce = (message: string): void => {
  if (warned) return;
  warned = true;
  console.warn(`[tracr] ${message}`);
};

export interface NodeAgentOptions extends Partial<RuntimeOptions> {
  /** Unix socket or named pipe of the daemon. Defaults to $TRACR_SOCKET. */
  socket?: string | null;
}

/**
 * Process-wide entry point for instrumented Node modules. Idempotent: every
 * transformed file calls this and gets back the same instance.
 *
 * A daemon that is down degrades to buffered-and-dropped events rather than
 * taking the host application down with it.
 */
export const installNodeAgent = (options: NodeAgentOptions = {}): TracrRuntime => {
  const socket = options.socket ?? process.env.TRACR_SOCKET ?? null;
  const transport =
    options.transport ??
    (socket === null || socket === "" ? undefined : nodeTransport({ path: socket }));

  const runtime = install(transport === undefined ? options : { ...options, transport });

  if (started) return runtime;
  started = true;

  // Until the daemon exists there is nowhere for a sink hit to go. This prints
  // the same derivation chain the Phase 0 gate dumps, from a live process.
  if (process.env.TRACR_DEBUG === "1") {
    runtime.onSink = ({ label }) => {
      process.stderr.write(`${runtime.explain(label)}\n`);
    };
  }

  if (transport !== undefined) {
    void runtime
      .start({
        runId: 0,
        procId: process.pid,
        language: "javascript",
        platform: "node",
        protocolVersion: PROTOCOL_VERSION,
      })
      .catch((err: unknown) => {
        warnOnce(`daemon not reachable at ${socket}: ${(err as Error).message}`);
      });
  }

  return runtime;
};
