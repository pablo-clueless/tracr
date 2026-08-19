import { describe, expect, it } from "vitest";
import { CombineOp, UNTAINTED } from "@pablo_clueless/protocol";

import { Interner } from "../src/interner.js";

describe("Interner", () => {
  it("hash-conses identical origins to the same label", () => {
    const interner = new Interner();
    expect(interner.origin(1, 10)).toBe(interner.origin(1, 10));
    expect(interner.size).toBe(1);
  });

  it("hash-conses identical combines to the same label", () => {
    const interner = new Interner();
    const a = interner.origin(1, 10);
    const b = interner.origin(2, 11);
    expect(interner.combine(CombineOp.Binary, 12, [a, b])).toBe(
      interner.combine(CombineOp.Binary, 12, [a, b]),
    );
  });

  it("never allocates when every operand is untainted", () => {
    const interner = new Interner();
    expect(interner.union(UNTAINTED, UNTAINTED, 10)).toBe(UNTAINTED);
    expect(interner.combine(CombineOp.Binary, 10, [UNTAINTED, UNTAINTED])).toBe(UNTAINTED);
    expect(interner.size).toBe(0);
  });

  it("passes a lone tainted operand through without a new node", () => {
    const interner = new Interner();
    const a = interner.origin(1, 10);
    expect(interner.union(a, UNTAINTED, 11)).toBe(a);
    expect(interner.union(UNTAINTED, a, 11)).toBe(a);
    expect(interner.size).toBe(1);
  });

  it("reserves label 0", () => {
    const interner = new Interner();
    expect(interner.origin(1, 10)).not.toBe(UNTAINTED);
    expect(interner.node(UNTAINTED)).toBeUndefined();
  });
});
