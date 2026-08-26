/**
 * Node-only entry point.
 *
 * Kept out of the main barrel on purpose: `transport-node` imports `node:net`,
 * and a bundler resolving that for the browser externalises it into a module
 * that throws on first property access. Re-exporting it from `index` breaks the
 * browser agent at import time, before a single line of the app runs.
 */
export { installNodeAgent, type NodeAgentOptions } from "./node-agent.js";
export { nodeTransport, type NodeTransportOptions } from "./transport-node.js";
