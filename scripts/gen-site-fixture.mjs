// Emits a site table from the real Babel pass, so the Rust skeleton builder is
// tested against bytes the transform actually produces rather than a hand-written
// approximation. Regenerate after a transform change.
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// @babel/core is a dependency of the plugin package, not of the workspace root.
const require = createRequire(join(HERE, "..", "packages", "babel-plugin", "package.json"));
const { transformSync } = require("@babel/core");
const { tracrBabelPlugin } = await import(
  pathToFileURL(join(HERE, "..", "packages", "babel-plugin", "dist", "plugin.js")).href
);

const APP = `
const helper = (raw) => raw.trim().toLowerCase();
export const handler = (req, res) => {
  const term = helper(req.body.name);
  return query("select * from users where name like ?", [term]);
};
const eager = helper("startup");
`;

const result = transformSync(APP, {
  filename: "src/routes.ts",
  plugins: [
    [
      tracrBabelPlugin,
      {
        sources: [{ id: "express.body", module: "express", path: "req.body" }],
        sinks: [{ id: "db.query", module: "*", path: "query" }],
      },
    ],
  ],
  configFile: false,
  babelrc: false,
});

// Babel resolves `filename` against cwd, so the raw table carries an absolute
// path from whichever machine ran this. Normalised here to keep the fixture
// portable and to avoid committing someone's home directory.
const table = result.metadata.tracr.siteTable;
table.sites = table.sites.map((site) => ({ ...site, file: "src/routes.ts" }));
const out = join(HERE, "..", "crates", "core", "tests", "fixtures");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "sites.json"), JSON.stringify(table, null, 2));
console.log(`sites.json  ${table.sites.length} sites`);
