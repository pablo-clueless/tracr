import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { loadConfig, resolveSocketPath } from "./config.js";
import type { LoaderData } from "./loader.js";

/**
 * `node --import @pablo_clueless/tracr/register app.js`
 *
 * Importing this module *is* the opt-in, so the socket is always resolved here:
 * a daemon that is down degrades to dropped events, it does not silently
 * disable instrumentation. Not importing it is the no-op path.
 */
const root = process.cwd();
const config = await loadConfig(root);

const data: LoaderData = {
  socket: process.env.TRACR_SOCKET ?? resolveSocketPath(root, config.socket),
  root,
  include: config.include,
  exclude: config.exclude,
  sources: config.sources,
  sinks: config.sinks,
};

register("./loader.js", pathToFileURL(import.meta.filename), { data });
