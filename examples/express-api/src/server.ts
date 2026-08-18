import express from "express";

import { query } from "./db.js";

const app = express();
app.use(express.json());

/**
 * The Phase 0 gate: `req.body.name` reaching `query(...)` must produce a
 * complete derivation chain *through Express middleware*. Taint survives here
 * because it is anchored on `req`, not carried in the call-scoped side channel.
 */
app.post("/users/search", (req, res) => {
  const name = req.body.name as string;
  const like = `%${name.trim().toLowerCase()}%`;
  const rows = query("select * from users where name like ?", [like]);
  res.json({ rows });
});

app.listen(3000, () => {
  process.stdout.write("example-express-api listening on :3000\n");
});
