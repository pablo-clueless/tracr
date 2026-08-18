import { describe, expect, it } from "vitest";

import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("drains in insertion order", () => {
    const buffer = new RingBuffer<number>(4);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.drain()).toEqual([1, 2]);
    expect(buffer.length).toBe(0);
  });

  it("drops on overflow and counts what it dropped", () => {
    const buffer = new RingBuffer<number>(2);
    expect(buffer.push(1)).toBe(true);
    expect(buffer.push(2)).toBe(true);
    expect(buffer.push(3)).toBe(false);
    expect(buffer.drain()).toEqual([1, 2]);
    expect(buffer.takeDropped()).toBe(1);
  });

  it("clears the drop counter so each report covers one interval", () => {
    const buffer = new RingBuffer<number>(1);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.takeDropped()).toBe(1);
    expect(buffer.takeDropped()).toBe(0);
  });

  it("wraps without losing entries", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.drain();
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);
    expect(buffer.drain()).toEqual([3, 4, 5]);
  });
});
