#!/usr/bin/env node
import { startDaemon } from "./daemon.js";
import { loadConfig } from "./config.js";

const USAGE = `tracr <command>

Commands:
  start     start the core daemon and the UI
  version   print the version
`;

const main = async (argv: string[]): Promise<number> => {
  const command = argv[0];

  switch (command) {
    case "start": {
      const config = await loadConfig(process.cwd());
      await startDaemon(config);
      return 0;
    }
    case "version":
      process.stdout.write("tracr 0.0.0\n");
      return 0;
    default:
      process.stdout.write(USAGE);
      return command === undefined ? 0 : 1;
  }
};

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
