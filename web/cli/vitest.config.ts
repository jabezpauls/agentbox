import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Markdown as text, as the bundle has it (esbuild's "text" loader).
  plugins: [
    {
      name: "markdown-text",
      transform(code: string, id: string) {
        return id.endsWith(".md") ? { code: `export default ${JSON.stringify(code)};`, map: null } : null;
      },
    },
  ],
  resolve: {
    // The link's codec from its source, as the typecheck and the bundle see it.
    alias: {
      "@workbench/hostcore/link": fileURLToPath(new URL("../hostcore/src/link/index.ts", import.meta.url)),
      "@workbench/hostcore/herdr": fileURLToPath(new URL("../hostcore/src/herdr/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
