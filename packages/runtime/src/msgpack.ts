/**
 * Hand-rolled MessagePack encoder. The agent only ever sends fixed-shape
 * arrays of integers and the occasional short string, so a dependency-free
 * encoder stays well under a kilobyte and keeps `$t` shippable to browsers.
 *
 * Covers the subset tracr needs: unsigned ints, strings, arrays, maps, nil,
 * bools. The Rust core decodes with `rmp`, which accepts any conforming
 * MessagePack.
 */
export class MsgPackWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  uint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`msgpack uint out of range: ${value}`);
    }
    if (value < 0x80) return this.byte(value);
    if (value <= 0xff) {
      this.ensure(2);
      this.buf[this.len++] = 0xcc;
      this.buf[this.len++] = value;
      return;
    }
    if (value <= 0xffff) {
      this.ensure(3);
      this.buf[this.len++] = 0xcd;
      this.view.setUint16(this.len, value);
      this.len += 2;
      return;
    }
    if (value <= 0xffffffff) {
      this.ensure(5);
      this.buf[this.len++] = 0xce;
      this.view.setUint32(this.len, value);
      this.len += 4;
      return;
    }
    this.ensure(9);
    this.buf[this.len++] = 0xcf;
    this.view.setUint32(this.len, Math.floor(value / 0x1_0000_0000));
    this.view.setUint32(this.len + 4, value >>> 0);
    this.len += 8;
  }

  str(value: string): void {
    const bytes = utf8.encode(value);
    const n = bytes.length;
    if (n < 32) {
      this.byte(0xa0 | n);
    } else if (n <= 0xff) {
      this.ensure(2);
      this.buf[this.len++] = 0xd9;
      this.buf[this.len++] = n;
    } else if (n <= 0xffff) {
      this.ensure(3);
      this.buf[this.len++] = 0xda;
      this.view.setUint16(this.len, n);
      this.len += 2;
    } else {
      this.ensure(5);
      this.buf[this.len++] = 0xdb;
      this.view.setUint32(this.len, n);
      this.len += 4;
    }
    this.ensure(n);
    this.buf.set(bytes, this.len);
    this.len += n;
  }

  arrayHeader(count: number): void {
    if (count < 16) return this.byte(0x90 | count);
    if (count <= 0xffff) {
      this.ensure(3);
      this.buf[this.len++] = 0xdc;
      this.view.setUint16(this.len, count);
      this.len += 2;
      return;
    }
    this.ensure(5);
    this.buf[this.len++] = 0xdd;
    this.view.setUint32(this.len, count);
    this.len += 4;
  }

  mapHeader(count: number): void {
    if (count < 16) return this.byte(0x80 | count);
    if (count <= 0xffff) {
      this.ensure(3);
      this.buf[this.len++] = 0xde;
      this.view.setUint16(this.len, count);
      this.len += 2;
      return;
    }
    this.ensure(5);
    this.buf[this.len++] = 0xdf;
    this.view.setUint32(this.len, count);
    this.len += 4;
  }

  nil(): void {
    this.byte(0xc0);
  }

  boolean(value: boolean): void {
    this.byte(value ? 0xc3 : 0xc2);
  }

  /** Writes any JSON-like value. Events are tuples, so numbers dominate. */
  value(input: unknown): void {
    if (input == null) return this.nil();
    switch (typeof input) {
      case "number":
        return Number.isInteger(input) ? this.uint(input) : this.f64(input);
      case "string":
        return this.str(input);
      case "boolean":
        return this.boolean(input);
      case "object":
        if (Array.isArray(input)) {
          this.arrayHeader(input.length);
          for (const item of input) this.value(item);
          return;
        }
        {
          const entries = Object.entries(input as Record<string, unknown>);
          this.mapHeader(entries.length);
          for (const [key, val] of entries) {
            this.str(key);
            this.value(val);
          }
        }
        return;
      default:
        throw new TypeError(`msgpack cannot encode ${typeof input}`);
    }
  }

  private f64(value: number): void {
    this.ensure(9);
    this.buf[this.len++] = 0xcb;
    this.view.setFloat64(this.len, value);
    this.len += 8;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const utf8 = new TextEncoder();

export const encodeMsgPack = (input: unknown): Uint8Array => {
  const writer = new MsgPackWriter();
  writer.value(input);
  return writer.finish();
};

/** 4-byte big-endian length prefix + payload, for stream transports. */
export const frameStream = (payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
};
