const USAGE = "Usage: workbench-bridge [--help]\n\nRuns the Workbench bridge server that proxies browser clients to herdr.";

function main(argv: string[]): void {
  if (argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  console.log(USAGE);
}

main(process.argv.slice(2));
