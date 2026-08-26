import { install, type RuntimeOptions, type TracrRuntime } from "./runtime.js";
import { PROTOCOL_VERSION } from "@pablo_clueless/protocol";
import { wsTransport } from "./transport-ws.js";

let warned = false;
let started = false;

const warnOnce = (message: string): void => {
  if (warned) return;
  warned = true;
  console.warn(`[tracr] ${message}`);
};

export interface WebAgentOptions extends Partial<RuntimeOptions> {
  /** WebSocket URL of the daemon. Instrumentation still runs without one. */
  url?: string | null;
  /** Print each sink's derivation chain to the console. */
  debug?: boolean;
}

/**
 * Browser counterpart to `installNodeAgent`. Idempotent: every transformed
 * module calls this and gets back the same instance.
 *
 * There is no process id in a browser, so a run is identified by a random
 * per-tab integer. Two tabs of the same app are two agents, which is correct.
 */
export const installWebAgent = (options: WebAgentOptions = {}): TracrRuntime => {
  const url = options.url ?? null;
  const transport =
    options.transport ?? (url === null || url === "" ? undefined : wsTransport({ url }));

  const runtime = install(transport === undefined ? options : { ...options, transport });

  if (started) return runtime;
  started = true;

  if (options.debug === true) {
    runtime.onSink = ({ label }) => {
      console.log(`[tracr]\n${runtime.explain(label)}`);
    };
  }

  if (transport !== undefined) {
    void runtime
      .start({
        runId: 0,
        procId: Math.floor(Math.random() * 0x7fffffff),
        language: "javascript",
        platform: "browser",
        protocolVersion: PROTOCOL_VERSION,
      })
      .catch((err: unknown) => {
        warnOnce(`daemon not reachable at ${url}: ${(err as Error).message}`);
      });
  }

  return runtime;
};
