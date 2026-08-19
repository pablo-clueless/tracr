import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tracr from "@pablo_clueless/vite";

// tracr must come after plugin-react: it cannot transform raw JSX.
export default defineConfig({
  plugins: [react(), tracr()],
});
