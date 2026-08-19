import type { SinkSpec, SourceSpec } from "@pablo_clueless/protocol";

export interface TracrConfig {
  /** Adapter package names, e.g. `["@pablo_clueless/react"]`. */
  adapters: string[];
  sources: SourceSpec[];
  sinks: SinkSpec[];
  include: string[];
  exclude: string[];
  /** Unix socket (Node) the daemon listens on. */
  socket: string;
  /** Port the UI connects to. */
  uiPort: number;
}

export const defaultConfig: TracrConfig = {
  adapters: [],
  sources: [],
  sinks: [],
  include: ["src/**/*.{js,jsx,ts,tsx}"],
  exclude: ["**/node_modules/**", "**/dist/**"],
  socket: ".tracr/daemon.sock",
  uiPort: 7331,
};

export const defineConfig = (config: Partial<TracrConfig>): TracrConfig => ({
  ...defaultConfig,
  ...config,
});

export const loadConfig = async (_cwd: string): Promise<TracrConfig> => defaultConfig;
