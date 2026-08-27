import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

import { tracrBabelPlugin } from "../src/plugin.js";

/**
 * Paths in the site table become node labels on someone's screen.
 *
 * An absolute one leaks the directory layout of whoever ran the build, and
 * makes every fixture and snapshot differ per machine — which is exactly what
 * happened before the transform relativised them.
 */

interface Built {
  sites: { file: string }[];
  calls?: { file: string }[];
}

const table = (code: string, filename: string, root: string): Built | undefined => {
  const result = transformSync(code, {
    filename,
    root,
    cwd: root,
    plugins: [[tracrBabelPlugin, { sources: [], sinks: [] }]],
    configFile: false,
    babelrc: false,
  });
  return (result?.metadata as { tracr?: { siteTable?: Built } } | undefined)?.tracr?.siteTable;
};

const SOURCE = `
const helper = (raw) => raw.trim();
const handler = (input) => helper(input) + "!";
`;

describe("file paths in the site table", () => {
  it("records a file relative to the project root", () => {
    const built = table(SOURCE, "/project/src/routes.ts", "/project");

    expect(built?.sites.length).toBeGreaterThan(0);
    for (const site of built?.sites ?? []) {
      expect(site.file).toBe("src/routes.ts");
    }
  });

  it("relativises call edges too, not just sites", () => {
    const built = table(SOURCE, "/project/src/routes.ts", "/project");

    expect(built?.calls?.length).toBeGreaterThan(0);
    for (const call of built?.calls ?? []) {
      expect(call.file).toBe("src/routes.ts");
    }
  });

  it("leaves no leading slash or drive letter behind", () => {
    const built = table(SOURCE, "/project/src/deep/nested.ts", "/project");

    for (const site of built?.sites ?? []) {
      expect(site.file.startsWith("/")).toBe(false);
      expect(site.file).not.toMatch(/^[A-Za-z]:/);
    }
  });

  it("uses forward slashes so one file is one node on every platform", () => {
    const built = table(SOURCE, "/project/src/deep/nested.ts", "/project");

    for (const site of built?.sites ?? []) {
      expect(site.file).not.toContain("\\");
    }
  });

  it("keeps a path outside the root absolute rather than a pile of dots", () => {
    // `../../../elsewhere/x.ts` names nothing a reader can find, and hides
    // that the file is outside the project at all.
    const built = table(SOURCE, "/elsewhere/x.ts", "/project");

    for (const site of built?.sites ?? []) {
      expect(site.file).not.toContain("..");
    }
  });
});
