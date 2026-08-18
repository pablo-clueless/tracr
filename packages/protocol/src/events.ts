import type { ProcId, RunId, SiteId } from "./site.js";
import type { Label } from "./labels.js";

/**
 * Agent -> core. Fixed-shape msgpack arrays, not maps: the tag is element 0 and
 * every arity is known statically, so decoding never allocates a key.
 */
export const EventTag = {
  Origin: 0,
  Combine: 1,
  Flow: 2,
  Sink: 3,
  Dropped: 4,
} as const;
export type EventTag = (typeof EventTag)[keyof typeof EventTag];

/** A declared source produced a fresh label. */
export type OriginEvent = [
  tag: typeof EventTag.Origin,
  site: SiteId,
  label: Label,
  sourceId: number,
];

/** A label was derived from parents. `op` is a `CombineOp`. */
export type CombineEvent = [
  tag: typeof EventTag.Combine,
  site: SiteId,
  label: Label,
  op: number,
  parents: Label[],
];

/** A label crossed from one site to another. */
export type FlowEvent = [tag: typeof EventTag.Flow, from: SiteId, to: SiteId, label: Label];

/** A tainted value reached a declared sink. */
export type SinkEvent = [tag: typeof EventTag.Sink, site: SiteId, label: Label, sinkId: number];

/**
 * The ring buffer overflowed and `count` events were discarded.
 * Must be surfaced in the UI: silent loss destroys trust faster than being slow.
 */
export type DroppedEvent = [tag: typeof EventTag.Dropped, count: number];

export type AgentEvent = CombineEvent | DroppedEvent | FlowEvent | OriginEvent | SinkEvent;

/** Sent once when an agent attaches, before any event. */
export interface AgentHello {
  runId: RunId;
  procId: ProcId;
  language: string;
  platform: "browser" | "node";
  protocolVersion: number;
}

export const PROTOCOL_VERSION = 1;
