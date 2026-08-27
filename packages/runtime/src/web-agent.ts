import { install, type RuntimeOptions, type TracrRuntime } from "./runtime.js";
import { PROTOCOL_VERSION, sinkIdOf, type SinkSpec } from "@pablo_clueless/protocol";
import { installFetchPropagation } from "./propagate.js";
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
  /**
   * Attach `x-tracr-labels` to outgoing `fetch` calls carrying tainted values.
   *
   * Off unless configured, and same-origin unless a host is named: the header
   * carries internal ids, and an app talks to third parties that have no
   * business receiving them.
   *
   * `sinks` must be the same array, in the same order, that the transform was
   * given — ids are positions in it.
   */
  propagate?: { sinks: SinkSpec[]; sinkId?: string; allowHosts?: string[] };
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

  // One id per tab, reused by the transport's hello and by any header this
  // agent attaches, so the two name the same process.
  const procId = Math.floor(Math.random() * 0x7fffffff);

  if (options.debug === true) {
    runtime.onSink = ({ label }) => {
      console.log(`[tracr]\n${runtime.explain(label)}`);
    };
  }

  if (options.propagate !== undefined) {
    const { sinks, sinkId = "fetch.body", allowHosts } = options.propagate;
    const index = sinkIdOf(sinks, sinkId);
    if (index === -1) {
      warnOnce(`cannot propagate: no sink declared with id "${sinkId}"`);
    } else {
      installFetchPropagation({
        runtime,
        sinkId: index,
        runId: 0,
        procId,
        allowHosts,
      });
    }
  }

  if (transport !== undefined) {
    void runtime
      .start({
        runId: 0,
        procId,
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
