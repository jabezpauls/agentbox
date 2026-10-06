#!/usr/bin/env node
// Assemble the gate's static files next to the compiled server: its own
// stylesheet and script, plus the app's design tokens, UI font and icon, copied at
// build time so the sign-in page and the app can never drift onto different
// palettes. The runtime image carries dist/ alone.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const out = path.join(pkg, "dist", "static");
const require = createRequire(import.meta.url);

fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(path.join(pkg, "src", "static"))) {
  fs.copyFileSync(path.join(pkg, "src", "static", name), path.join(out, name));
}
fs.copyFileSync(path.resolve(pkg, "../app/src/theme/tokens.css"), path.join(out, "tokens.css"));
fs.copyFileSync(path.resolve(pkg, "../app/public/favicon.svg"), path.join(out, "favicon.svg"));
const inter = path.join(
  path.dirname(require.resolve("@fontsource-variable/inter/package.json")),
  "files",
  "inter-latin-wght-normal.woff2",
);
fs.copyFileSync(inter, path.join(out, "inter.woff2"));
