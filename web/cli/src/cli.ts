import { run } from "./main.js";
import { MIN_NODE_MAJOR, nodeMajor } from "./version.js";

// The bundle's entry point: check Node, run, and exit once what was written
// has been handed to the OS (a pipe on macOS is asynchronous, and exiting
// early would cut the output short).
if (nodeMajor() < MIN_NODE_MAJOR) {
  process.stderr.write(`agentbox needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${process.version}. See https://nodejs.org\n`);
  process.exit(1);
}

const code = await run(process.argv.slice(2), { signals: true });
process.exitCode = code;
process.stdout.write("", () => process.exit(code));
