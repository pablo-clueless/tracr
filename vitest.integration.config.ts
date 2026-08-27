import { defineConfig } from "vitest/config";

/**
 * Cross-language tests: a real JavaScript agent against a real tracr-core
 * process. Separated from the default run because they need `cargo build`
 * first, not because they are optional — this is the only suite that catches
 * the two sides drifting apart at runtime.
 */
export default defineConfig({
  test: {
    include: ["packages/*/test/**/daemon.test.ts"],
    testTimeout: 30000,
    environment: "node",
    // One daemon binds a port at a time; parallel files would race for them.
    fileParallelism: false,
  },
});
