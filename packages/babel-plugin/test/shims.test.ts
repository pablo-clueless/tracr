import { describe, expect, it } from "vitest";

import { transform } from "./harness.js";
import type { ShimSpec } from "@pablo_clueless/protocol";

const shims: ShimSpec[] = [
  { id: "react.useState", module: "react", export: "useState", via: "@x/react/shim" },
  { id: "react.useRef", module: "react", export: "useRef", via: "@x/react/shim" },
];

const compile = (source: string) => transform(source, { shims }).code;

describe("shim import redirection", () => {
  it("splits shimmed names out of the framework import", () => {
    const out = compile(`import { useState, useEffect } from "react";`);

    expect(out).toMatch(/import \{ useEffect \} from "react"/);
    expect(out).toMatch(/import \{ useState \} from "@x\/react\/shim"/);
  });

  it("replaces the declaration outright when every name is shimmed", () => {
    const out = compile(`import { useState, useRef } from "react";`);

    expect(out).toMatch(/import \{ useState, useRef \} from "@x\/react\/shim"/);
    expect(out).not.toMatch(/from "react"/);
  });

  it("preserves the local alias", () => {
    const out = compile(`import { useState as useS } from "react";`);
    expect(out).toMatch(/import \{ useState as useS \} from "@x\/react\/shim"/);
  });

  it("leaves a default import alone", () => {
    // `React.useState(...)` is a member call, not an import binding.
    const out = compile(`import React from "react";`);
    expect(out).toMatch(/import React from "react"/);
    expect(out).not.toContain("@x/react/shim");
  });

  it("leaves other modules alone", () => {
    const out = compile(`import { useState } from "preact/hooks";`);
    expect(out).toMatch(/from "preact\/hooks"/);
    expect(out).not.toContain("@x/react/shim");
  });

  it("is inert when no shims are configured", () => {
    const out = transform(`import { useState } from "react";`, {}).code;
    expect(out).toMatch(/import \{ useState \} from "react"/);
  });

  it("ignores a shim with no destination", () => {
    const out = transform(`import { useState } from "react";`, {
      shims: [{ id: "x", module: "react", export: "useState" }],
    }).code;
    expect(out).toMatch(/import \{ useState \} from "react"/);
  });
});
