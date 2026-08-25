import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tracr from "@pablo_clueless/vite";

// tracr must come after plugin-vue: an uncompiled SFC is not instrumentable.
export default defineConfig({
  // TRACR_DISABLE lets the HMR benchmark measure the same app without the plugin.
  plugins: [vue(), tracr({ enabled: process.env.TRACR_DISABLE !== "1" })],
});
