import type { AgentEvent, AgentHello } from "@tracr/protocol";

/**
 * Agents encode to MessagePack and ship over a unix socket (Node) or a
 * WebSocket (browser). The runtime only knows this interface.
 */
export interface Transport {
  open(hello: AgentHello): Promise<void>;
  send(batch: AgentEvent[], dropped: number): void;
  close(): Promise<void>;
}

/** Default until an agent installs a real one. Keeps `$t` usable in tests. */
export const nullTransport: Transport = {
  open: async () => {},
  send: () => {},
  close: async () => {},
};
