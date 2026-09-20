import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// One build serves any base path: assets resolve relatively (`base: "./"`) and
// the runtime derives its API/WS base from location.pathname (see
// src/api/base.ts). In dev we serve under the default base path so the proxy
// and the runtime base agree; the built output keeps the relative base.
export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/workbench/" : "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@workbench/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // Vite serves the app under /workbench/; only the API and WS routes are
    // proxied to the bridge so the dev base and the runtime base agree.
    proxy: {
      "^/workbench/(api|ws|preview)": {
        target: "http://localhost:7800",
        changeOrigin: true,
        ws: true,
      },
    },
  },
}));
