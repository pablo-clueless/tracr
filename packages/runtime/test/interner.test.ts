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

  it("records a step for a half-tainted union rather than folding it away", () => {
    // Folding would keep the taint set identical and lose a link in the
    // derivation chain, which is the thing the tool exists to show.
    const interner = new Interner();
    const a = interner.origin(1, 10);

    const derived = interner.union(a, UNTAINTED, 11);
    expect(derived).not.toBe(a);
    expect(derived).not.toBe(UNTAINTED);

    // Same operands at the same site hash-cons to the same node, either order.
    expect(interner.union(UNTAINTED, a, 11)).toBe(derived);
    expect(interner.size).toBe(2);
  });

  it("reserves label 0", () => {
    const interner = new Interner();
    expect(interner.origin(1, 10)).not.toBe(UNTAINTED);
    expect(interner.node(UNTAINTED)).toBeUndefined();
  });
});
