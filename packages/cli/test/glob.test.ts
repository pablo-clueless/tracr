import { describe, expect, it } from "vitest";

import { createFilter, globToRegExp } from "../src/glob.js";

describe("globToRegExp", () => {
  it("keeps `*` inside a single segment", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/deep/index.ts")).toBe(false);
  });

  it("spans zero or more segments with `**/`", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/a/b/index.ts")).toBe(true);
    expect(re.test("lib/index.ts")).toBe(false);
  });

  it("expands brace alternation", () => {
    const re = globToRegExp("src/**/*.{js,jsx,ts,tsx}");
    for (const ext of ["js", "jsx", "ts", "tsx"]) {
      expect(re.test(`src/a/file.${ext}`)).toBe(true);
    }
    expect(re.test("src/a/file.css")).toBe(false);
  });

  it("treats regex metacharacters in the pattern as literals", () => {
    const re = globToRegExp("src/a+b.ts");
    expect(re.test("src/a+b.ts")).toBe(true);
    expect(re.test("src/aab.ts")).toBe(false);
  });

  it("matches a single character with `?`", () => {
    const re = globToRegExp("src/?.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/ab.ts")).toBe(false);
  });
});

describe("createFilter", () => {
  const filter = createFilter(["src/**/*.{js,ts}"], ["**/node_modules/**", "**/*.test.ts"]);

  it("includes what the include patterns name", () => {
    expect(filter("src/server.ts")).toBe(true);
    expect(filter("src/a/b/db.js")).toBe(true);
  });

  it("excludes what no include pattern names", () => {
    expect(filter("scripts/build.js")).toBe(false);
  });

  it("lets exclusion win over inclusion", () => {
    expect(filter("src/server.test.ts")).toBe(false);
    expect(filter("src/node_modules/pkg/index.js")).toBe(false);
  });

  it("includes everything when include is empty", () => {
    const open = createFilter([], ["dist/**"]);
    expect(open("anything/at/all.ts")).toBe(true);
    expect(open("dist/bundle.js")).toBe(false);
  });

  it("normalises windows separators", () => {
    expect(filter("src\\a\\b.ts")).toBe(true);
  });
});
