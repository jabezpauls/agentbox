import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The machines UI: a second entry, built apart from the Workbench (into
// dist-machines/) and carried by the gate's image, which serves it on the
// machines origin (machines.html at `/`, its files under /assets/). It shares
// the Workbench's components, pointed at a machine with setApiBase.
export default defineConfig({
  base: "/",
  plugins: [react()],
  publicDir: false,
  resolve: {
    alias: {
      "@workbench/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist-machines",
    emptyOutDir: true,
    // Under `script-src 'self'`: no inline module-preload polyfill.
    modulePreload: { polyfill: false },
    rollupOptions: { input: fileURLToPath(new URL("machines.html", import.meta.url)) },
  },
});
