#!/usr/bin/env node
// Bundle the CLI into one file, dist/agentbox.mjs: the program and `ws`,
// nothing else to install. The box serves this file at /cli/agentbox.mjs and
// the install script puts it on PATH as `agentbox`.
//
// The banner's second line, `// agentbox-cli <version>`, is how `agentbox
// update` tells what it downloaded. The `require` it defines is for `ws`, which
// is CommonJS: bundled into an ES module, its require() of Node's own modules
// needs a real one to call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
// Another place to write it to, for the tests.
const outfile = path.resolve(process.argv[2] ?? path.join(pkgDir, "dist", "agentbox.mjs"));

await build({
  entryPoints: [path.join(pkgDir, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // ws's optional native speed-ups: absent, it falls back to JavaScript.
  external: ["bufferutil", "utf-8-validate"],
  define: { __AGENTBOX_CLI_VERSION__: JSON.stringify(version) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// agentbox-cli ${version}`,
      'import { createRequire as __agentboxCreateRequire } from "node:module";',
      "const require = __agentboxCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "warning",
});
fs.chmodSync(outfile, 0o755);
console.log(`built ${path.relative(process.cwd(), outfile)} (agentbox ${version}, ${Math.round(fs.statSync(outfile).size / 1024)} KiB)`);
