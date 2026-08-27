import { create } from "zustand";

import type { CoreDelta, Skeleton } from "@pablo_clueless/protocol";
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
  version: number;

  setLevel: (level: NodeLevel) => void;
  setConnected: (connected: boolean) => void;
  selectEdge: (edgeId: string | null) => void;
  ingestSkeleton: (skeleton: Skeleton) => void;
  ingestDelta: (delta: CoreDelta) => void;
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
  version: 0,

  setLevel: (level) => set({ level }),
  setConnected: (connected) => set({ connected }),
  selectEdge: (selectedEdge) => set({ selectedEdge }),

  ingestSkeleton: (skeleton) => {
    applySkeleton(get().graph, skeleton);
    set((state) => ({ version: state.version + 1 }));
  },

  ingestDelta: (delta) => {
    applyDelta(get().graph, delta);
    set((state) => ({
      version: state.version + 1,
      dropped: delta.droppedTotal,
      unresolved: delta.unresolved,
      truncated: delta.truncated,
      lost: delta.lost,
    }));
  },
}));
