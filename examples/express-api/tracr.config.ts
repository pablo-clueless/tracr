import { defineConfig } from "@pablo_clueless/tracr";

export default defineConfig({
  sources: [
    { id: "express.body", module: "express", path: "req.body" },
    { id: "express.query", module: "express", path: "req.query" },
    { id: "express.params", module: "express", path: "req.params" },
  ],
  sinks: [{ id: "db.query", module: "./src/db.ts", path: "query", args: [0, 1] }],
});
