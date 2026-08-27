import { create } from "zustand";

import type { CoreChain, CoreDelta, Skeleton } from "@pablo_clueless/protocol";
import {
  applyDelta,
  applySkeleton,
  createGraph,
  type NodeLevel,
  type TracrGraph,
} from "../graph/model";

interface GraphState {
  graph: TracrGraph;
  level: NodeLevel;
  /** Total events the agent discarded. Surfaced in the UI: silent loss destroys trust. */
  dropped: number;
  /** Flows naming a site the skeleton lacks — the static parse and the run disagree. */
  unresolved: number;
  /** Derivation chains cut short by the DAG's depth cap. */
  truncated: number;
  /** Labels that read as untainted because they were lost. Flows we may be missing. */
  lost: number;
  connected: boolean;
  selectedEdge: string | null;
  /** The derivation behind the selected node, once the core answers. */
  chain: CoreChain | null;
  version: number;
  /**
   * Bumped only when an element appears or disappears. Layout keys off this
   * rather than `version`, which moves on every count change.
   */
  topology: number;

  setLevel: (level: NodeLevel) => void;
  setConnected: (connected: boolean) => void;
  selectEdge: (edgeId: string | null) => void;
  ingestSkeleton: (skeleton: Skeleton) => void;
  ingestDelta: (delta: CoreDelta) => void;
  ingestChain: (chain: CoreChain) => void;
  /** Positions moved but no element did — the renderer needs to redraw. */
  bumpVersion: () => void;
  clearChain: () => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  graph: createGraph(),
  level: "file",
  dropped: 0,
  unresolved: 0,
  truncated: 0,
  lost: 0,
  connected: false,
  selectedEdge: null,
  chain: null,
  version: 0,
  topology: 0,

  setLevel: (level) => set({ level }),
  setConnected: (connected) => set({ connected }),
  selectEdge: (selectedEdge) => set({ selectedEdge }),

  ingestSkeleton: (skeleton) => {
    applySkeleton(get().graph, skeleton);
    set((state) => ({
      version: state.version + 1,
      topology: state.topology + 1,
      chain: null,
    }));
  },

  // Replaces rather than merges: a chain is the answer to one question, and
  // holding a stale one behind a new click would show the wrong derivation.
  ingestChain: (chain) => set({ chain }),
  bumpVersion: () => set((state) => ({ version: state.version + 1 })),
  clearChain: () => set({ chain: null }),

  ingestDelta: (delta) => {
    const topologyChanged = applyDelta(get().graph, delta);
    set((state) => ({
      topology: state.topology + (topologyChanged ? 1 : 0),
      version: state.version + 1,
      dropped: delta.droppedTotal,
      unresolved: delta.unresolved,
      truncated: delta.truncated,
      lost: delta.lost,
    }));
  },
}));
