import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tracr from "@pablo_clueless/vite";

// tracr must come after plugin-react: it cannot transform raw JSX.
export default defineConfig({
  // debug: print each sink hit's derivation chain to the browser console.
  plugins: [react(), tracr({ debug: true })],
  // The shim imports "react" itself; without dedupe pnpm can hand it a second
  // copy and every hook call fails.
  resolve: { dedupe: ["react", "react-dom"] },
});
