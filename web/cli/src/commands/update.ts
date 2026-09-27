import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bool } from "../args.js";
import { CliError } from "../errors.js";
import { VERSION } from "../version.js";
import { command, type Command } from "./types.js";

/** The first lines of every bundle: the shebang, then `// agentbox-cli <version>`. */
export function bundleVersion(bundle: Buffer | string): string | null {
  const head = (typeof bundle === "string" ? bundle : bundle.subarray(0, 512).toString("utf8")).split("\n", 3);
  if (!head[0]?.startsWith("#!") || !head[0].includes("node")) return null;
  const m = /^\/\/ agentbox-cli (\S+)/.exec(head[1] ?? "");
  return m ? (m[1] as string) : null;
}

/**
 * The file this CLI runs from, and whether replacing it is this command's
 * business: a copy installed by the install script is; a build inside a
 * checkout (`npm i -g ./web/cli` links to it) is updated with git instead.
 */
export function selfInstall(argv1: string | undefined): { file: string; checkout: boolean } | null {
  if (!argv1) return null;
  let file: string;
  try {
    file = fs.realpathSync(argv1);
  } catch {
    return null;
  }
  let checkout = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "..", "package.json"), "utf8")) as { name?: string };
    checkout = pkg.name === "@workbench/cli";
  } catch {
    // No package beside it: an installed copy.
  }
  return { file, checkout };
}

export const update = command({
  path: ["update"],
  summary: "replace this CLI with the box's own build",
  usage: "",
  options: [{ name: "check", type: "boolean", description: "only say whether the box has a different build" }],
  details: "Downloads /cli/agentbox.mjs from the box (the current one, or --box), checks it runs, and swaps it in\nin one step.",
  async run(ctx, p) {
    const { name, box } = ctx.selected();
    const self = selfInstall(process.argv[1]);
    if (!self) throw new CliError("cannot tell which file this CLI runs from");
    if (self.checkout && !bool(p.options, "check")) {
      throw new CliError(`this CLI runs from a checkout (${self.file}); update it with git and \`npm run build -w cli\` instead`);
    }

    // A public, open-source file: fetched without the token.
    const client = ctx.client(box.url, null);
    const res = await client.ok("GET", "/cli/agentbox.mjs", { auth: false, what: "downloading the CLI" });
    const chunks: Buffer[] = [];
    for await (const c of res.stream) chunks.push(c as Buffer);
    const bundle = Buffer.concat(chunks);
    const version = bundleVersion(bundle);
    if (!version) throw new CliError(`${box.url}/cli/agentbox.mjs is not an agentbox CLI build`);

    const current = fs.readFileSync(self.file);
    if (bundle.equals(current)) {
      ctx.out(`Already up to date: agentbox ${VERSION}, the same build ${name} serves.\n`);
      return;
    }
    if (bool(p.options, "check")) {
      ctx.out(`${name} serves agentbox ${version}${version === VERSION ? " (a different build of the same version)" : ""}; this is ${VERSION}. Run \`agentbox update\`.\n`);
      return;
    }

    const dir = path.dirname(self.file);
    // Named .mjs like the real one: Node reads an ES module only by that
    // extension (a bare name works only on the newest releases).
    const tmp = path.join(dir, `.agentbox-update-${randomBytes(4).toString("hex")}.mjs`);
    try {
      fs.writeFileSync(tmp, bundle, { mode: 0o755 });
      fs.chmodSync(tmp, 0o755);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new CliError(`cannot write to ${dir} (${(err as Error).message}); reinstall with the box's install script`);
    }
    // Only a build that starts is swapped in.
    const check = spawnSync(process.execPath, [tmp, "--version"], { encoding: "utf8", timeout: 30_000 });
    if (check.status !== 0) {
      fs.rmSync(tmp, { force: true });
      throw new CliError(`the downloaded build does not run here: ${(check.stderr || check.stdout || "").trim().slice(0, 300)}`);
    }
    try {
      fs.renameSync(tmp, self.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new CliError(`cannot replace ${self.file}: ${(err as Error).message}`);
    }
    ctx.out(`Updated agentbox ${VERSION} → ${version} from ${name}.\n`);
  },
});

export const UPDATE_COMMANDS: Command[] = [update];
