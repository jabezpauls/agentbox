import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The shared host code from its source, as the typecheck sees it: the
    // tests run before anything is built.
    alias: {
      "@workbench/hostcore": fileURLToPath(new URL("../hostcore/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
