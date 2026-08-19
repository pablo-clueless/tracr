import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tracr from "@pablo_clueless/vite";

// tracr must come after plugin-vue: an uncompiled SFC is not instrumentable.
export default defineConfig({
  plugins: [vue(), tracr()],
});
