import type { SinkSpec, SourceSpec } from "@tracr/protocol";

export interface TracrConfig {
  /** Adapter package names, e.g. `["@tracr/react"]`. */
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
