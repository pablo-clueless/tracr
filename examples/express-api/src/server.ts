import express from "express";
import type { NextFunction, Request, Response } from "express";

import { query } from "./db.js";

const app = express();
app.use(express.json());

/** What the middleware parks on the request for the handler to pick up. */
interface SearchRequest extends Request {
  searchTerm?: string;
}

/**
 * Reads the declared source and parks the derived value back on `req`.
 *
 * Everything between this returning and the handler running is Express's own
 * dispatch, which is never instrumented. The argument side channel is dead
 * across it; only the label anchored on `req` survives.
 */
const normalize = (req: SearchRequest, _res: Response, next: NextFunction): void => {
  const raw = req.body.name as string;
  req.searchTerm = raw.trim().toLowerCase();
  next();
};

/**
 * The Phase 0 gate: the value reaching `query` here must carry a complete
 * derivation chain back to `req.body.name` in the middleware above.
 */
app.post("/users/search", normalize, (req: SearchRequest, res: Response) => {
  const like = `%${req.searchTerm}%`;
  const rows = query("select * from users where name like ?", [like]);
  res.json({ rows });
});

app.listen(3000, () => {
  process.stdout.write("example-express-api listening on :3000\n");
});
