import type { ShimSpec, SinkSpec, SourceSpec, TracrAdapter } from "@pablo_clueless/protocol";

/** The handler binding is named by whoever wrote it, so the root is a wildcard. */
const sources: SourceSpec[] = [{ id: "react.input.value", module: "*", path: "*.target.value" }];

const sinks: SinkSpec[] = [
  { id: "fetch.body", module: "*", path: "fetch", args: [1] },
  { id: "dom.innerHTML", module: "*", path: "Element.innerHTML" },
];

/**
 * React stores `useState` values in the fiber. A primitive has nowhere to hang a
 * label and the shadow local is gone by the next render, so these three are
 * shimmed to capture the label on set and restore it on read.
 *
 * Props and context need no shim: they are objects, so the WeakMap anchors them.
 */
const shims: ShimSpec[] = [
  { id: "react.useState", module: "react", export: "useState" },
  { id: "react.useReducer", module: "react", export: "useReducer" },
  { id: "react.useRef", module: "react", export: "useRef" },
];

export const reactAdapter: TracrAdapter = {
  name: "react",
  sources,
  sinks,
  shims,
};

export default reactAdapter;
