import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * React is mocked rather than rendered. The shims' whole job is bookkeeping
 * around React's hooks — a side table keyed on the setter, and a per-index
 * anchor on the returned tuple — so a fake with the one property that matters
 * (a setter whose identity is stable across renders) exercises it exactly.
 */
const cells = new Map<number, { value: unknown; setter: (next: unknown) => void }>();
let cursor = 0;

/** Advances to the next render, replaying the same hook order. */
const render = () => {
  cursor = 0;
};

const useCell = (initial: unknown) => {
  const index = cursor++;
  let cell = cells.get(index);
  if (cell === undefined) {
    cell = {
      value: typeof initial === "function" ? (initial as () => unknown)() : initial,
      setter: (next: unknown) => {
        const current = cells.get(index);
        if (current !== undefined) current.value = next;
      },
    };
    cells.set(index, cell);
  }
  return [cell.value, cell.setter] as [unknown, (next: unknown) => void];
};

vi.mock("react", () => ({
  useState: (initial: unknown) => useCell(initial),
  useReducer: (_r: unknown, initial: unknown) => useCell(initial),
  useRef: (initial: unknown) => {
    const index = cursor++;
    let cell = cells.get(index);
    if (cell === undefined) {
      cell = { value: { current: initial }, setter: () => {} };
      cells.set(index, cell);
    }
    return cell.value as { current: unknown };
  },
}));

const { install } = await import("@pablo_clueless/runtime");
const { useReducer, useRef, useState } = await import("../src/shims.js");

const runtime = install();

/** Stands in for the transform's `argTaint = [...]` immediately before a call. */
const withArgLabel = <T>(label: number, call: () => T): T => {
  runtime.argTaint = [label];
  const result = call();
  runtime.argTaint = null;
  return result;
};

beforeEach(() => {
  cells.clear();
  cursor = 0;
  runtime.argTaint = null;
});

describe("useState shim", () => {
  it("labels the value position and leaves the setter clean", () => {
    const pair = withArgLabel(7, () => useState("seed"));

    expect(runtime.readAnchor(pair, 0)).toBe(7);
    expect(runtime.readAnchor(pair, 1)).toBe(0);
  });

  it("carries a label set in one render into the next", () => {
    const [, setValue] = withArgLabel(0, () => useState(""));

    // A component calling setValue(term) with a tainted term.
    withArgLabel(42, () => setValue("ada"));

    render();
    const next = useState("");

    expect(next[0]).toBe("ada");
    expect(runtime.readAnchor(next, 0)).toBe(42);
  });

  it("keeps the setter identity stable across renders", () => {
    const first = useState("");
    render();
    const second = useState("");

    expect(second[1]).toBe(first[1]);
  });

  it("clears the label when an untainted value is set", () => {
    const [, setValue] = withArgLabel(0, () => useState(""));
    withArgLabel(42, () => setValue("ada"));

    render();
    expect(runtime.readAnchor(useState(""), 0)).toBe(42);

    withArgLabel(0, () => setValue("plain"));
    render();
    expect(runtime.readAnchor(useState(""), 0)).toBe(0);
  });

  it("keeps two hooks in the same component independent", () => {
    const a = withArgLabel(1, () => useState("a"));
    const b = withArgLabel(2, () => useState("b"));

    expect(runtime.readAnchor(a, 0)).toBe(1);
    expect(runtime.readAnchor(b, 0)).toBe(2);
  });

  it("does not consume the side channel twice", () => {
    withArgLabel(9, () => useState("seed"));
    // takeArgs() clears it; a later untracked call must not inherit the label.
    render();
    expect(runtime.readAnchor(useState("seed"), 1)).toBe(0);
  });
});

describe("useReducer shim", () => {
  it("labels the state position from the dispatch that set it", () => {
    const [, dispatch] = withArgLabel(0, () => useReducer((s: string) => s, ""));
    withArgLabel(13, () => dispatch("action" as never));

    render();
    expect(
      runtime.readAnchor(
        useReducer((s: string) => s, ""),
        0,
      ),
    ).toBe(13);
  });
});

describe("useRef shim", () => {
  it("anchors an initial value onto current", () => {
    const ref = withArgLabel(5, () => useRef("seed"));
    expect(runtime.readAnchor(ref, "current")).toBe(5);
  });

  it("leaves an untainted ref unlabelled", () => {
    const ref = withArgLabel(0, () => useRef("seed"));
    expect(runtime.readAnchor(ref, "current")).toBe(0);
  });
});
