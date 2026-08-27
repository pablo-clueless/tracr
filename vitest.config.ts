import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx"],
    // Needs a built tracr-core binary, so it runs in its own job rather than
    // failing for anyone who has not touched the Rust side.
    exclude: ["**/node_modules/**", "**/dist/**", "**/daemon.test.ts"],
    testTimeout: 15000,
    environment: "node",
  },
});
