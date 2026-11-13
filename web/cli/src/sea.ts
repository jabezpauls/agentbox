import { run } from "./main.js";

// The standalone executable's entry point (scripts/build-sea.mjs). A single
// executable application runs one CommonJS script, which cannot use top-level
// `await` as cli.ts does, so this is the same in a function. Node is the one
// built in: there is no version to check.
async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), { signals: true });
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}

void main();
