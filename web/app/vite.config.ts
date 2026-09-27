import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The app is served at the root of the box's origin. Asset URLs are absolute
// so a deep link (`/files/src/a.ts`) loads the same bundle as `/`; the bridge
// answers every such route with index.html.
export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@workbench/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // In dev Vite serves the app; the API, the sockets and the preview proxy
    // are the bridge's.
    proxy: {
      "^/(api|ws|preview)(/|$)": {
        target: "http://localhost:7800",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
