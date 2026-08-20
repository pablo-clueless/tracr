import { describe, expect, it } from "vitest";

import { run, sink, source } from "./harness.js";

/**
 * Phase 0 gate.
 *
 * `req.body.name` read in middleware must reach `query(...)` in a separate
 * handler with a complete derivation chain, *through* uninstrumented framework
 * dispatch. If this fails, stop: every later phase assumes it holds.
 */

/** A faithfully uninstrumented router. Injected untransformed, like the real thing. */
const makeRouter = () => {
  const stack: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
  return {
    post(_path: string, ...handlers: typeof stack) {
      stack.push(...handlers);
    },
    dispatch(req: unknown, res: unknown) {
      let index = 0;
      const next = (): void => {
        const handler = stack[index++];
        if (handler !== undefined) handler(req, res, next);
      };
      next();
    },
  };
};

const APP = `
  const app = makeRouter();

  const normalize = (req, res, next) => {
    const raw = req.body.name;
    req.searchTerm = raw.trim().toLowerCase();
    next();
  };

  app.post("/users/search", normalize, (req, res) => {
    const like = \`%\${req.searchTerm}%\`;
    const rows = query("select * from users where name like ?", [like]);
    res.json({ rows });
  });

  out.send = (body) => app.dispatch({ body }, { json: () => {} });
`;

const options = {
  sources: [source("express.body", "req.body")],
  sinks: [sink("db.query", "query", [0, 1])],
};

describe("Phase 0 gate: express-api", () => {
  const execute = () => {
    const queries: unknown[] = [];
    const result = run(APP, {
      ...options,
      externals: {
        makeRouter,
        query: (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      },
    });
    (result.out.send as (body: unknown) => void)({ name: "  Ada  " });
    return { result, queries };
  };

  it("reaches the sink with a tainted label", () => {
    const { result, queries } = execute();

    expect(queries).toHaveLength(1);
    expect(result.sinks.length).toBeGreaterThan(0);
  });

  it("produces a derivation chain back to req.body", () => {
    const { result } = execute();
    const chain = result.chain();

    expect(chain).toContain("origin express.body");
    // trim/toLowerCase are uninstrumented natives; the summary table is what
    // carries taint across them.
    expect(chain).toContain("builtin");
    expect(chain).toContain("template");
    expect(chain).toContain("container");
  });

  it("attributes every step to a file, a line and the enclosing function", () => {
    const { result } = execute();
    const chain = result.chain();

    expect(chain).toContain("example.js:");
    // The value is read and derived inside the middleware, not the handler.
    expect(chain).toContain("(normalize)");
    // Distinct sites: trim and toLowerCase are separate steps, not one blur.
    const sites = new Set(chain.split("\n").map((line) => line.split(" at ")[1]));
    expect(sites.size).toBeGreaterThan(3);
  });

  it("does not run the value through the dead argument side channel", () => {
    // The proof that anchoring is what carried it: nothing else could have.
    const { result } = execute();
    expect(result.code).toContain("anchor");
    expect(result.code).toContain("readAnchor");
  });

  it("leaves an untainted request completely untraced", () => {
    const queries: unknown[] = [];
    const result = run(APP, {
      ...options,
      sources: [source("express.body", "req.nothing")],
      externals: {
        makeRouter,
        query: (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      },
    });
    (result.out.send as (body: unknown) => void)({ name: "  Ada  " });

    expect(queries).toHaveLength(1);
    expect(result.sinks).toHaveLength(0);
    expect(result.runtime.interner.size).toBe(0);
  });
});
