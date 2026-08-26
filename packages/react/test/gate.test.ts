import { beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../babel-plugin/test/harness.js";
import type { TracrRuntime } from "@pablo_clueless/runtime";

/**
 * Phase 2 gate, React half.
 *
 * A value typed into an input must reach a `fetch` body with its provenance
 * intact, using the specs `@pablo_clueless/react` ships.
 *
 * React is mocked for the same reason as in `shims.test.ts`: the shims are
 * bookkeeping around the hooks, and the only property that matters is a setter
 * whose identity is stable across renders.
 */
const cells = new Map<number, { value: unknown; setter: (next: unknown) => void }>();
let cursor = 0;

const useCell = (initial: unknown) => {
  const index = cursor++;
  let cell = cells.get(index);
  if (cell === undefined) {
    cell = {
      value: initial,
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
  useRef: (initial: unknown) => ({ current: initial }),
}));

const { useState } = await import("../src/shims.js");
const { reactAdapter } = await import("../src/index.js");

/**
 * A component body, as the transform sees it after JSX has been compiled away.
 * Re-invoking `render` is a re-render: the hook order repeats and the shadow
 * locals are rebuilt from the tuple's anchors.
 */
const COMPONENT = `
  out.render = () => {
    const [name, setName] = useState("");

    const onChange = (event) => setName(event.target.value);

    const submit = async () => {
      await fetch("/users/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
    };

    return { onChange, submit };
  };
`;

interface Handlers {
  onChange: (event: unknown) => void;
  submit: () => Promise<void>;
}

const mount = () => {
  const calls: { url: string; init: { body?: string } }[] = [];
  const result = run(COMPONENT, {
    sources: reactAdapter.sources,
    sinks: reactAdapter.sinks,
    externals: {
      useState,
      fetch: (url: string, init: { body?: string }) => {
        calls.push({ url, init });
        return Promise.resolve({});
      },
    },
  });

  // The shims resolve the runtime through the global the agent installs.
  (globalThis as { __tracr?: TracrRuntime }).__tracr = result.runtime;

  const render = (): Handlers => {
    cursor = 0;
    return (result.out.render as () => Handlers)();
  };

  return { result, calls, render };
};

beforeEach(() => {
  cells.clear();
  cursor = 0;
});

describe("Phase 2 gate: react-vite-app", () => {
  it("declares the three hooks that need shimming", () => {
    expect(reactAdapter.shims?.map((shim) => shim.export)).toEqual([
      "useState",
      "useReducer",
      "useRef",
    ]);
  });

  it("delivers the typed value to the fetch body", async () => {
    const { calls, render } = mount();

    render().onChange({ target: { value: "ada" } });
    await render().submit();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe('{"name":"ada"}');
  });

  it("reaches the fetch sink with a tainted label", async () => {
    const { result, render } = mount();

    render().onChange({ target: { value: "ada" } });
    await render().submit();

    expect(result.sinks.length).toBeGreaterThan(0);
  });

  it("produces a chain from the input back to the declared source", async () => {
    const { result, render } = mount();

    render().onChange({ target: { value: "ada" } });
    await render().submit();

    const chain = result.chain();
    expect(chain).toContain("origin react.input.value");
    expect(chain).toContain("container");
  });

  it("carries the label across the re-render, not just within one", async () => {
    // The value is typed during render 1 and read during render 2. Nothing in
    // between is a live shadow local: only the side table keyed on the setter
    // and the tuple anchor put it back.
    const { result, render } = mount();

    render().onChange({ target: { value: "ada" } });
    const second = render();
    await second.submit();

    expect(result.sinks.length).toBeGreaterThan(0);
  });

  it("leaves an untouched component completely untraced", async () => {
    const { result, calls, render } = mount();

    await render().submit();

    expect(calls).toHaveLength(1);
    expect(result.sinks).toHaveLength(0);
    expect(result.runtime.interner.size).toBe(0);
  });
});
