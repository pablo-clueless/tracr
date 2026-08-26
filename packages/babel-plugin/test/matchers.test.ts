import { describe, expect, it } from "vitest";

import { matchSource } from "../src/matchers.js";
import type { SourceSpec } from "@pablo_clueless/protocol";

const spec = (id: string, path: string): SourceSpec => ({ id, module: "*", path });

describe("matchSource", () => {
  const sources = [spec("express.body", "req.body")];

  it("matches the declared path itself", () => {
    expect(matchSource("req.body", sources)?.spec.id).toBe("express.body");
  });

  it("taints everything reachable underneath it", () => {
    expect(matchSource("req.body.name", sources)?.spec.id).toBe("express.body");
    expect(matchSource("req.body.user.email", sources)?.spec.id).toBe("express.body");
  });

  it("does not match a sibling with a shared prefix", () => {
    expect(matchSource("req.bodyguard", sources)).toBeNull();
    expect(matchSource("req.query", sources)).toBeNull();
  });

  it("lets the longest declared prefix win", () => {
    const both = [spec("broad", "req.body"), spec("narrow", "req.body.name")];
    expect(matchSource("req.body.name", both)?.spec.id).toBe("narrow");
    expect(matchSource("req.body.other", both)?.spec.id).toBe("broad");
  });
});

describe("matchSource with a wildcard root", () => {
  // The same DOM source arrives under whatever name the handler's author chose.
  const sources = [spec("input.value", "*.target.value")];

  it.each(["event.target.value", "$event.target.value", "e.target.value", "evt.target.value"])(
    "matches %s regardless of the binding name",
    (path) => {
      expect(matchSource(path, sources)?.spec.id).toBe("input.value");
    },
  );

  it("still taints everything underneath", () => {
    expect(matchSource("e.target.value.raw", sources)?.spec.id).toBe("input.value");
  });

  it("consumes exactly one segment, not an arbitrary prefix", () => {
    // Otherwise `*.target.value` quietly claims unrelated nested state.
    expect(matchSource("form.state.target.value", sources)).toBeNull();
  });

  it("does not match a bare identifier", () => {
    expect(matchSource("target", sources)).toBeNull();
    expect(matchSource("value", sources)).toBeNull();
  });

  it("does not match a different tail", () => {
    expect(matchSource("e.target.checked", sources)).toBeNull();
    expect(matchSource("e.currentTarget.value", sources)).toBeNull();
  });

  it("loses to a more specific literal declaration", () => {
    const both = [spec("wild", "*.target.value"), spec("exact", "event.target.value")];
    expect(matchSource("event.target.value", both)?.spec.id).toBe("exact");
    expect(matchSource("e.target.value", both)?.spec.id).toBe("wild");
  });
});
