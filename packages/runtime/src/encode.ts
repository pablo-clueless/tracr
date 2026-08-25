import { FrameType, type AgentEvent, type AgentHello } from "@pablo_clueless/protocol";

import { encodeMsgPack } from "./msgpack.js";

export const encodeHello = (hello: AgentHello): Uint8Array =>
  encodeMsgPack([
    FrameType.Hello,
    hello.protocolVersion,
    hello.runId,
    hello.procId,
    hello.language,
    hello.platform,
  ]);

/** One flush interval of events plus the ring buffer's drop count. */
export const encodeBatch = (events: AgentEvent[], dropped: number): Uint8Array =>
  encodeMsgPack([FrameType.Batch, events, dropped]);
