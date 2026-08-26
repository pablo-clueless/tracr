import { describe, it } from "vitest";
import { run, sink, source } from "./harness.js";

const probe = (label: string, src: string) => {
  const result = run(src, {
    sources: [source("in", "*.target.value")],
    sinks: [sink("out", "send", [0])],
    externals: { useState: (i: unknown) => [i, () => {}], send: () => {} },
  });
  (result.out.go as (e: unknown) => void)({ target: { value: "X" } });
  console.log(`\n### ${label}\nsinks=${result.sinks.length}\n${result.chain()}`);
};

describe("probe", () => {
  it("array destructuring from a literal", () => {
    probe("array destructure", `
      out.go = (e) => { const v = e.target.value; const [a, b] = [v, 1]; send(a); };
    `);
  });
  it("array destructuring from a call", () => {
    probe("destructure from call", `
      out.go = (e) => { const v = e.target.value; const [a, s] = useState(v); send(a); };
    `);
  });
  it("plain call return", () => {
    probe("plain call return", `
      const id = (x) => x;
      out.go = (e) => { const v = e.target.value; const w = id(v); send(w); };
    `);
  });
  it("member read off call result", () => {
    probe("member off call", `
      const wrap = (x) => ({ v: x });
      out.go = (e) => { const v = e.target.value; const o = wrap(v); send(o.v); };
    `);
  });
});
