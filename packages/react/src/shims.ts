import * as React from "react";

import type { TracrRuntime } from "@pablo_clueless/runtime";
import type { Label } from "@pablo_clueless/protocol";

const runtime = (): TracrRuntime | undefined => (globalThis as { __tracr?: TracrRuntime }).__tracr;

/**
 * React keeps a `useState` value in the fiber. A primitive has nowhere to hang a
 * label, and the shadow local that held one is gone by the next render — so the
 * label lives here instead, in a side table that outlives the render.
 *
 * Keyed on the **setter**, not on a hook index. React guarantees the setter is
 * stable for the life of the hook, so this survives conditional hooks, which is
 * exactly where an index-based scheme silently mislabels state. That was an open
 * question in HANDOFF; setter identity is the answer.
 */
const held = new WeakMap<object, Label>();

/** Wrappers are cached so the setter a component sees keeps a stable identity. */
const wrappers = new WeakMap<object, unknown>();

const UNTAINTED = 0 as Label;

/** The label the caller parked on the side channel, consumed exactly once. */
const incoming = (rt: TracrRuntime | undefined): Label =>
  (rt?.takeArgs()?.[0] ?? UNTAINTED) as Label;

/**
 * A setter that records what it was handed. The value itself goes to React
 * untouched — the label rides alongside, keyed on the original setter.
 */
const trackingSetter = <T>(rt: TracrRuntime, setter: T): T => {
  const existing = wrappers.get(setter as object);
  if (existing !== undefined) return existing as T;

  const wrapped = ((next: unknown) => {
    const label = incoming(rt);
    if (label === UNTAINTED) held.delete(setter as object);
    else held.set(setter as object, label);
    return (setter as (value: unknown) => unknown)(next);
  }) as T;

  wrappers.set(setter as object, wrapped);
  return wrapped;
};

/**
 * The tuple is what the destructuring reads: `const [v, set] = useState()`
 * compiles to a per-index anchor lookup, so index 0 carries the value's label
 * and index 1 stays clean. Tainting the setter would be wrong — it is a
 * function, not the data.
 */
const tuple = <A, B>(rt: TracrRuntime | undefined, value: A, setter: B, label: Label): [A, B] => {
  if (rt === undefined) return [value, setter];
  const pair: [A, B] = [value, trackingSetter(rt, setter)];
  rt.anchor(pair, 0, label);
  return pair;
};

export function useState<S>(initial: S | (() => S)): [S, React.Dispatch<React.SetStateAction<S>>] {
  const rt = runtime();
  const initialLabel = incoming(rt);

  const [value, setValue] = React.useState(initial);

  // First render only: the initial value carries whatever the caller passed in.
  if (rt !== undefined && initialLabel !== UNTAINTED && !held.has(setValue)) {
    held.set(setValue, initialLabel);
  }

  return tuple(rt, value, setValue, held.get(setValue) ?? UNTAINTED);
}

export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S,
): [S, React.Dispatch<A>] {
  const rt = runtime();
  const initialLabel = incoming(rt);

  // React's overloads do not survive being forwarded generically; the cast is
  // confined to the call and the public signature above stays honest.
  const [state, dispatch] = (init === undefined
    ? React.useReducer(reducer as never, initialArg as never)
    : React.useReducer(reducer as never, initialArg as never, init as never)) as unknown as [
    S,
    React.Dispatch<A>,
  ];

  if (rt !== undefined && initialLabel !== UNTAINTED && !held.has(dispatch)) {
    held.set(dispatch, initialLabel);
  }

  return tuple(rt, state, dispatch, held.get(dispatch) ?? UNTAINTED);
}

/**
 * A ref object is already anchorable, so writes from instrumented code label
 * themselves. The shim exists only for the initial value, which arrives through
 * the side channel before any instrumented write happens.
 */
export function useRef<T>(initial: T): React.RefObject<T> {
  const rt = runtime();
  const initialLabel = incoming(rt);

  const ref = React.useRef(initial) as React.RefObject<T>;
  if (rt !== undefined && initialLabel !== UNTAINTED) {
    rt.anchor(ref, "current", initialLabel);
  }
  return ref;
}
