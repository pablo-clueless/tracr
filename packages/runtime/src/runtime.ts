import {
  CombineOp,
  EventTag,
  UNTAINTED,
  type AgentEvent,
  type AgentHello,
  type Label,
  type SiteId,
  type SiteInfo,
  type SiteTable,
} from "@pablo_clueless/protocol";

import { anchor, anchorSelf, readAnchor, readSelf, reanchor } from "./anchor.js";
import { nullTransport, type Transport } from "./transport.js";
import { RingBuffer } from "./ring-buffer.js";
import { formatChain } from "./explain.js";
import { Interner } from "./interner.js";

export interface RuntimeOptions {
  bufferSize: number;
  flushIntervalMs: number;
  transport: Transport;
}

const DEFAULTS: RuntimeOptions = {
  bufferSize: 1 << 14,
  flushIntervalMs: 250,
  transport: nullTransport,
};

/**
 * The `$t` object the transform emits calls against.
 *
 * Every entry point short-circuits on `UNTAINTED` before doing any work. That
 * short-circuit is the performance thesis: most values are untainted, and if any
 * of these methods allocates on an all-zero input the whole approach collapses.
 */
export class TracrRuntime {
  readonly interner = new Interner();

  /** Side channel. Never change function arity to pass taint. */
  argTaint: Label[] | null = null;
  retTaint: Label = UNTAINTED;

  private readonly sites = new Map<SiteId, SiteInfo>();
  private readonly sourceNames = new Map<number, string>();
  private readonly buffer: RingBuffer<AgentEvent>;
  private readonly options: RuntimeOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<RuntimeOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.buffer = new RingBuffer<AgentEvent>(this.options.bufferSize);
  }

  origin(sourceId: number, site: SiteId): Label {
    const label = this.interner.origin(sourceId, site);
    this.buffer.push([EventTag.Origin, site, label, sourceId]);
    return label;
  }

  union(a: Label, b: Label, site: SiteId): Label {
    if (a === UNTAINTED && b === UNTAINTED) return UNTAINTED;
    const label = this.interner.union(a, b, site);
    this.buffer.push([EventTag.Combine, site, label, CombineOp.Binary, [a, b]]);
    return label;
  }

  combine(op: CombineOp, site: SiteId, parents: Label[]): Label {
    const label = this.interner.combine(op, site, parents);
    if (label === UNTAINTED) return UNTAINTED;
    this.buffer.push([EventTag.Combine, site, label, op, parents]);
    return label;
  }

  sink(sinkId: number, site: SiteId, label: Label): void {
    if (label === UNTAINTED) return;
    this.buffer.push([EventTag.Sink, site, label, sinkId]);
    this.onSink?.({ sinkId, site, label });
  }

  /**
   * Phase 0 has no daemon and no UI, so a sink hit has nowhere to go. This is
   * the seam the spike observes instead.
   */
  onSink: ((event: { sinkId: number; site: SiteId; label: Label }) => void) | null = null;

  flow(from: SiteId, to: SiteId, label: Label): void {
    if (label === UNTAINTED) return;
    this.buffer.push([EventTag.Flow, from, to, label]);
  }

  /** Read and clear the argument channel at function entry. */
  takeArgs(): Label[] | null {
    const args = this.argTaint;
    this.argTaint = null;
    return args;
  }

  takeReturn(): Label {
    const label = this.retTaint;
    this.retTaint = UNTAINTED;
    return label;
  }

  readonly anchor = anchor;
  readonly readAnchor = readAnchor;
  readonly anchorSelf = anchorSelf;
  readonly readSelf = readSelf;
  readonly reanchor = reanchor;

  /**
   * The transform ships integers; these tables turn them back into file, line
   * and source name for a human-readable chain.
   */
  registerSites(table: SiteTable): void {
    for (const info of table.sites) this.sites.set(info.siteId, info);
  }

  registerSources(specs: { id: string }[]): void {
    specs.forEach((spec, sourceId) => this.sourceNames.set(sourceId, spec.id));
  }

  /** The derivation chain for a label, source-first. */
  explain(label: Label): string {
    return formatChain(this.interner, label, {
      sites: this.sites,
      sourceNames: this.sourceNames,
    });
  }

  async start(hello: AgentHello): Promise<void> {
    await this.options.transport.open(hello);
    this.timer = setInterval(() => this.flush(), this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  flush(): void {
    const dropped = this.buffer.takeDropped();
    const batch = this.buffer.drain();
    if (batch.length === 0 && dropped === 0) return;
    this.options.transport.send(batch, dropped);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    await this.options.transport.close();
  }
}

declare global {
  var __tracr: TracrRuntime | undefined;
}

/** Instrumented modules resolve `$t` through here, once per process. */
export const install = (options?: Partial<RuntimeOptions>): TracrRuntime => {
  globalThis.__tracr ??= new TracrRuntime(options);
  return globalThis.__tracr;
};
