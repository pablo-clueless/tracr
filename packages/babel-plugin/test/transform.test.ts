import { describe, expect, it } from "vitest";
import { UNTAINTED } from "@pablo_clueless/protocol";

import { run, sink, source } from "./harness.js";

const sources = [source("input.value", "input.value")];
const sinks = [sink("db.query", "query")];

describe("declarations and binary ops", () => {
  it("gives a declared source an origin label that reaches a sink", () => {
    const result = run(
      `
      const name = input.value;
      query(name);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(1);
    expect(result.sinks[0]?.label).not.toBe(UNTAINTED);
    expect(result.chain()).toContain("origin input.value");
  });

  it("unions both operands of a binary op", () => {
    const result = run(
      `
      const a = input.value;
      const b = input.value2;
      query(a + b);
      `,
      {
        sources: [source("a", "input.value"), source("b", "input.value2")],
        sinks,
        externals: { input: { value: "x", value2: "y" }, query: () => {} },
      },
    );

    const chain = result.chain();
    expect(chain).toContain("origin a");
    expect(chain).toContain("origin b");
    expect(chain).toContain("binary");
  });

  it("propagates through a template literal", () => {
    const result = run(
      `
      const name = input.value;
      query(\`%\${name}%\`);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(1);
    expect(result.chain()).toContain("origin input.value");
  });
});

describe("the untainted short-circuit", () => {
  it("interns nothing at all when no source is involved", () => {
    const result = run(
      `
      const a = 1;
      const b = a + 2;
      const c = \`\${b}\`;
      query(c);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(0);
    expect(result.runtime.interner.size).toBe(0);
  });

  it("emits no union call for a statically untainted binary op", () => {
    const result = run(`const b = 1 + 2; out.b = b;`, { sources, sinks });
    expect(result.code).not.toContain("union");
    expect(result.out.b).toBe(3);
  });
});

describe("assignment propagation", () => {
  it("carries taint through a reassignment", () => {
    const result = run(
      `
      let value = "clean";
      value = input.value;
      query(value);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(1);
    expect(result.chain()).toContain("origin input.value");
  });

  it("clears the shadow when a tainted binding is overwritten with a clean value", () => {
    const result = run(
      `
      let value = input.value;
      value = "clean";
      query(value);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(0);
  });

  it("keeps the existing label on a compound assignment", () => {
    const result = run(
      `
      let value = input.value;
      value += "!";
      query(value);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(1);
    expect(result.chain()).toContain("origin input.value");
  });
});

describe("calls and returns", () => {
  it("carries taint into a function through the argument side channel", () => {
    const result = run(
      `
      const normalize = (raw) => raw.trim();
      const name = input.value;
      const clean = normalize(name);
      query(clean);
      `,
      { sources, sinks, externals: { input: { value: " ada " }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(1);
    expect(result.chain()).toContain("origin input.value");
  });

  it("never changes the arity of an instrumented function", () => {
    const result = run(
      `
      function two(a, b) { return a; }
      out.length = two.length;
      out.value = two(1, 2);
      `,
      { sources, sinks },
    );

    expect(result.out.length).toBe(2);
    expect(result.out.value).toBe(1);
  });

  it("does not misattribute a discarded call's return label", () => {
    const result = run(
      `
      const make = () => input.value;
      const clean = () => "clean";
      make();
      const value = clean();
      query(value);
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(0);
  });
});

describe("object anchoring", () => {
  it("survives a value being parked on an object and read back elsewhere", () => {
    const result = run(
      `
      const bag = {};
      const stash = (target) => { target.held = input.value; };
      const read = (target) => target.held;
      stash(bag);
      query(read(bag));
      `,
      { sources, sinks, externals: { input: { value: "ada" }, query: () => {} } },
    );

    expect(result.sinks).toHaveLength(1);
    expect(result.chain()).toContain("origin input.value");
  });
});
