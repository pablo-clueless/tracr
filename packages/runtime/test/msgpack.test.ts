import { describe, expect, it } from "vitest";
import { decode, decodeMulti } from "@msgpack/msgpack";

import { EventTag, FrameType } from "@pablo_clueless/protocol";
import { encodeMsgPack, frameStream, MsgPackWriter } from "../src/msgpack.js";
import { encodeBatch, encodeHello } from "../src/encode.js";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("MsgPackWriter", () => {
  it("encodes positive fixint", () => {
    expect(hex(encodeMsgPack(0))).toBe("00");
    expect(hex(encodeMsgPack(127))).toBe("7f");
  });

  it("escalates uint widths by magnitude", () => {
    expect(hex(encodeMsgPack(128))).toBe("cc80");
    expect(hex(encodeMsgPack(255))).toBe("ccff");
    expect(hex(encodeMsgPack(256))).toBe("cd0100");
    expect(hex(encodeMsgPack(65535))).toBe("cdffff");
    expect(hex(encodeMsgPack(65536))).toBe("ce00010000");
    expect(hex(encodeMsgPack(0xffffffff))).toBe("ceffffffff");
    expect(hex(encodeMsgPack(0x1_0000_0000))).toBe("cf0000000100000000");
  });

  it("rejects negative integers rather than mis-encoding them as uints", () => {
    expect(() => encodeMsgPack(-1)).toThrow(RangeError);
  });

  it("routes fractional values to float64 and round-trips", () => {
    expect(decode(encodeMsgPack(1.5))).toBe(1.5);
  });

  it("encodes fixstr and str8/16 by byte length", () => {
    expect(hex(encodeMsgPack("abc"))).toBe("a3616263");
    const str8 = "x".repeat(32);
    expect(encodeMsgPack(str8)[0]).toBe(0xd9);
    expect(decode(encodeMsgPack(str8))).toBe(str8);
    const str16 = "y".repeat(256);
    expect(encodeMsgPack(str16)[0]).toBe(0xda);
    expect(decode(encodeMsgPack(str16))).toBe(str16);
  });

  it("encodes multi-byte utf-8 by byte length, not char count", () => {
    // Four CJK chars are 12 bytes in UTF-8, still fixstr-range.
    const s = "\u4e2d\u6587\u6d4b\u8bd5";
    const bytes = encodeMsgPack(s);
    expect(bytes[0]).toBe(0xa0 | 12);
    expect(decode(bytes)).toBe(s);
  });

  it("encodes array headers by arity", () => {
    expect(hex(encodeMsgPack([1, 2]))).toBe("920102");
    const big: number[] = new Array(20).fill(1);
    expect(encodeMsgPack(big)[0]).toBe(0xdc);
    expect(decode(encodeMsgPack(big))).toEqual(big);
  });

  it("encodes nested arrays and maps round-trip through the reference decoder", () => {
    const value = {
      events: [
        [0, 10, 1, 7],
        [2, 11, 12, 3],
      ],
      dropped: 4,
    };
    expect(decode(encodeMsgPack(value))).toEqual(value);
  });

  it("grows its buffer across many appends without corruption", () => {
    const writer = new MsgPackWriter(4);
    const items: number[] = [];
    for (let i = 0; i < 1000; i++) {
      writer.uint(i);
      items.push(i);
    }
    writer.arrayHeader(0);
    expect(Array.from(decodeMulti(writer.finish()))).toEqual([...items, []]);
  });
});

describe("frame encoders", () => {
  it("prefixes stream frames with a big-endian u32 length", () => {
    const payload = new Uint8Array([0xaa, 0xbb]);
    const framed = frameStream(payload);
    expect(hex(framed)).toBe("00000002aabb");
  });

  it("encodes hello as a fixed-shape array tagged with FrameType.Hello", () => {
    const bytes = encodeHello({
      runId: 1,
      procId: 2,
      language: "js",
      platform: "node",
      protocolVersion: 1,
    });
    const decoded = decode(bytes) as unknown[];
    expect(decoded[0]).toBe(FrameType.Hello);
    expect(decoded).toEqual([0, 1, 1, 2, "js", "node"]);
  });

  it("encodes a batch of protocol events plus the drop count", () => {
    const bytes = encodeBatch(
      [
        [EventTag.Origin, 10, 1, 7],
        [EventTag.Combine, 11, 2, 0, [1, 1]],
        [EventTag.Flow, 11, 12, 2],
        [EventTag.Sink, 13, 2, 9],
        [EventTag.Dropped, 5],
      ],
      3,
    );
    const decoded = decode(bytes) as unknown[];
    expect(decoded[0]).toBe(FrameType.Batch);
    expect(decoded[1]).toEqual([
      [0, 10, 1, 7],
      [1, 11, 2, 0, [1, 1]],
      [2, 11, 12, 2],
      [3, 13, 2, 9],
      [4, 5],
    ]);
    expect(decoded[2]).toBe(3);
  });
});
