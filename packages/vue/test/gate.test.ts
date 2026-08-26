import { describe, expect, it } from "vitest";

import { run } from "../../babel-plugin/test/harness.js";
import { vueAdapter } from "../src/index.js";

/**
 * Phase 2 gate, Vue half.
 *
 * A value typed into an input must reach a `fetch` body with its provenance
 * intact, using only the specs `@pablo_clueless/vue` ships — no per-test
 * sources, and no shims.
 *
 * The source below is the shape plugin-vue actually emits, not the shape the
 * SFC is written in. tracr runs `enforce: 'post'`, so the template is already a
 * render function by the time it sees it: the handler is an arrow taking
 * `$event`, and the ref is a `RefImpl` object rather than a bare binding.
 */

/** Uninstrumented, like the real thing: `ref` comes from node_modules. */
const ref = <T>(value: T): { value: T } => ({ value });

const APP = `
  const name = ref("");

  out.onInput = ($event) => (name.value = $event.target.value);

  out.search = async () => {
    const term = name.value.trim().toLowerCase();
    await fetch("/users/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: term }),
    });
  };
`;

const execute = () => {
  const calls: { url: string; init: { body?: string } }[] = [];
  const result = run(APP, {
    sources: vueAdapter.sources,
    sinks: vueAdapter.sinks,
    externals: {
      ref,
      fetch: (url: string, init: { body?: string }) => {
        calls.push({ url, init });
        return Promise.resolve({});
      },
    },
  });
  return { result, calls };
};

const type = async (text: string) => {
  const { result, calls } = execute();
  (result.out.onInput as (event: unknown) => void)({ target: { value: text } });
  await (result.out.search as () => Promise<void>)();
  return { result, calls };
};

describe("Phase 2 gate: vue-vite-app", () => {
  it("ships no shims — the RefImpl is an object, so anchoring is enough", () => {
    expect(vueAdapter.shims).toBeUndefined();
  });

  it("delivers the typed value to the fetch body", async () => {
    const { calls } = await type("  Ada  ");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe('{"name":"ada"}');
  });

  it("reaches the fetch sink with a tainted label", async () => {
    const { result } = await type("  Ada  ");
    expect(result.sinks.length).toBeGreaterThan(0);
  });

  it("produces a chain from the input back to the declared source", async () => {
    const { result } = await type("  Ada  ");
    const chain = result.chain();

    expect(chain).toContain("origin vue.input.value");
    // trim/toLowerCase and JSON.stringify are uninstrumented natives; the
    // summary table is the only thing carrying taint across them.
    expect(chain).toContain("builtin");
    // The request init and the payload object are both containers.
    expect(chain).toContain("container");
  });

  it("survives the hop between the handler and the submit function", async () => {
    // Nothing links `onInput` to `search` except the ref they share, and the
    // side channel is dead between two separately dispatched callbacks.
    const { result } = await type("  Ada  ");
    expect(result.code).toContain("anchor");
    expect(result.code).toContain("readAnchor");
  });

  it("attributes every step to a distinct site", async () => {
    const { result } = await type("  Ada  ");
    const sites = new Set(
      result
        .chain()
        .split("\n")
        .map((line) => line.split(" at ")[1]),
    );
    expect(sites.size).toBeGreaterThan(3);
  });

  it("leaves an untyped run completely untraced", async () => {
    const { result, calls } = execute();
    // search() without ever typing: the ref holds its untainted initial value.
    await (result.out.search as () => Promise<void>)();

    expect(calls).toHaveLength(1);
    expect(result.sinks).toHaveLength(0);
    expect(result.runtime.interner.size).toBe(0);
  });
});
