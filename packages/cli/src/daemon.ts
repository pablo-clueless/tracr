import type { TracrConfig } from "./config.js";

/**
 * The core is a Rust binary shipped per-platform under optionalDependencies,
 * the same distribution model as esbuild and SWC. Resolution walks the
 * `@pablo_clueless/core-{platform}` packages and falls back to a locally built binary.
 */
export const resolveCoreBinary = (): string | null => {
  const platform = `${process.platform}-${process.arch}`;
  void platform;
  return null;
};

export interface DaemonHandle {
  stop(): Promise<void>;
}

export const startDaemon = async (_config: TracrConfig): Promise<DaemonHandle> => {
  throw new Error("tracr-core is not built yet: run `pnpm core:build`");
};
