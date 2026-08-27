import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The main entry ships into the browser. A bundler that meets `node:net` there
 * externalises it into a module which throws on first property access, so a
 * single stray re-export takes the whole web agent down at import time —
 * before any application code runs, with an error that names the bundler
 * rather than the cause.
 *
 * This walks the real import graph instead of trusting the barrel to stay
 * tidy: the regression arrives as `export * from "./something"` that only
 * transitively reaches a Node builtin.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

const importsOf = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1] as string);

const reachableFrom = async (entry: string): Promise<Map<string, string>> => {
  const seen = new Map<string, string>();
  const queue = [resolve(SRC, entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;

    const source = await readFile(file, "utf8");
    seen.set(file, source);

    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith(".")) continue;
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }

  return seen;
};

const nodeBuiltinsIn = (modules: Map<string, string>): string[] => {
  const offenders: string[] = [];
  for (const [file, source] of modules) {
    for (const specifier of importsOf(source)) {
      if (specifier.startsWith("node:")) offenders.push(`${file} imports ${specifier}`);
    }
  }
  return offenders;
};

describe("browser safety of the main entry", () => {
  it("reaches no node: builtin from index", async () => {
    expect(nodeBuiltinsIn(await reachableFrom("index.ts"))).toEqual([]);
  });

  it("does not reach the node transport from index", async () => {
    const files = [...(await reachableFrom("index.ts")).keys()];
    expect(files.some((file) => file.endsWith("transport-node.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("node-agent.ts"))).toBe(false);
  });

  it("still reaches the browser transport and agent from index", async () => {
    const files = [...(await reachableFrom("index.ts")).keys()];
    expect(files.some((file) => file.endsWith("transport-ws.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("web-agent.ts"))).toBe(true);
  });

  it("keeps the node entry as the only route to node builtins", async () => {
    // The split is only worth anything if the node side still works.
    const files = [...(await reachableFrom("node.ts")).keys()];
    expect(files.some((file) => file.endsWith("transport-node.ts"))).toBe(true);
    expect(nodeBuiltinsIn(await reachableFrom("node.ts")).length).toBeGreaterThan(0);
  });
});
