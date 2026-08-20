// Phase 0 deliverable: console-dump the derivation chain.
// Run `pnpm build` first, then `pnpm --filter @pablo_clueless/babel-plugin gate`.
import { transformSync } from "@babel/core";
import { tracrBabelPlugin } from "../dist/plugin.js";
import { TracrRuntime } from "@pablo_clueless/runtime";

const makeRouter = () => {
  const stack = [];
  return {
    post(_p, ...h) {
      stack.push(...h);
    },
    dispatch(req, res) {
      let i = 0;
      const next = () => {
        const h = stack[i++];
        if (h) h(req, res, next);
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
  sources: [{ id: "express.body", module: "express", path: "req.body" }],
  sinks: [{ id: "db.query", module: "./db.js", path: "query", args: [0, 1] }],
};

const result = transformSync(APP, {
  filename: "src/server.js",
  babelrc: false,
  configFile: false,
  plugins: [[tracrBabelPlugin, options]],
});
const code = result.code;

const rt = new TracrRuntime();
const hits = [];
rt.onSink = (h) => hits.push(h);
rt.registerSources(options.sources);
rt.registerSites(result.metadata.tracr.siteTable);

const out = {};
new Function("__tracr", "out", "makeRouter", "query", code)(rt, out, makeRouter, () => []);
out.send({ name: "  Ada  " });

console.log("\n=== SINK HITS: " + hits.length + " ===");
console.log("\n=== DERIVATION CHAIN (label #" + hits[0]?.label + ") ===");
console.log(rt.explain(hits[0].label));
console.log("\nDAG nodes: " + rt.interner.size);
