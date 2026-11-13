import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bool, str } from "../args.js";
import { normalizeBoxUrl } from "../config.js";
import type { Context } from "../context.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { safeText } from "../format.js";
import { VERSION } from "../version.js";
import { callControl } from "../node/control.js";
import { readCredentials, writeCredentials } from "../node/credentials.js";
import { installHerdr } from "../node/install.js";
import { joinMachine } from "../node/join.js";
import { NodeLink } from "../node/link.js";
import { nodeDir, nodePaths, type NodePaths } from "../node/paths.js";
import { askPassphrase, enrol } from "../node/presence.js";
import { Prompter } from "../node/prompt.js";
import { loadPolicy, setPaused, summarize, type FileMode } from "../node/policy.js";
import { runNode } from "../node/run.js";
import { execStart, installService, removeService, serviceInstalled, UNIT_NAME } from "../node/service-linux.js";
import { freeBytes, gatherSpecs } from "../node/specs.js";
import { sleep } from "../device.js";
import { command, type Command } from "./types.js";

/**
 * `agentbox node …`: this computer as a machine of a box. See the design,
 * docs/design/2026-11-13-machines-design.md.
 */

function paths(ctx: Context): NodePaths {
  return nodePaths(nodeDir(ctx.env, ctx.env.HOME || os.homedir(), ctx.platform));
}

function home(ctx: Context): string {
  return ctx.env.HOME || os.homedir();
}

/** `--folder ~/code,~/notes:read`: comma-separated folders, each `write` unless it says `:read`. */
export function parseFolders(raw: string, homeDir: string): Array<{ path: string; mode: FileMode }> {
  const out: Array<{ path: string; mode: FileMode }> = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)(?::(read|write))?$/.exec(part) as RegExpExecArray;
    let p = m[1] as string;
    if (p === "~") p = homeDir;
    else if (p.startsWith("~/")) p = path.join(homeDir, p.slice(2));
    p = path.resolve(p);
    if (p === path.resolve(homeDir)) throw new UsageError("not the whole home folder: name the project folders the box may use");
    out.push({ path: p, mode: (m[2] as FileMode | undefined) ?? "write" });
  }
  return out;
}

function printPolicy(ctx: Context, p: NodePaths): void {
  try {
    ctx.err(`${fs.readFileSync(p.policy, "utf8")}`);
  } catch {
    ctx.err("(no policy.json)\n");
  }
}

const join = command({
  path: ["node", "join"],
  summary: "join this computer to a box as a machine",
  usage: "<box-url>",
  operands: { min: 1, max: 1 },
  details:
    "Installs what the node runs (verified), asks for the machines passphrase here, shows a code to type\n" +
    "on the box's machines Admin page, writes policy.json if there is none, and starts the node as a\n" +
    "systemd user service.",
  options: [
    { name: "name", type: "string", value: "name", description: "what the box calls this machine (default: the hostname)" },
    { name: "folder", type: "string", value: "dirs", description: "folders the box may use, comma-separated, each dir or dir:read (asked when absent)" },
    { name: "no-service", type: "boolean", description: "do not register a service; run `agentbox node run` yourself" },
  ],
  async run(ctx, p) {
    const box = normalizeBoxUrl(p.operands[0] as string);
    const np = paths(ctx);
    const prompt = new Prompter(ctx.io.stdin, ctx.io.stderr);
    const folderArg = str(p.options, "folder");
    const noService = bool(p.options, "no-service") || ctx.platform !== "linux";
    try {
      await joinMachine(
        { box, name: str(p.options, "name") ?? os.hostname(), folders: folderArg !== undefined ? parseFolders(folderArg, home(ctx)) : null },
        {
          paths: np,
          platform: ctx.platform,
          arch: process.arch,
          hostname: os.hostname(),
          now: ctx.now,
          err: (s) => ctx.err(s),
          client: ctx.client(box, null),
          freeBytes,
          install: async () => {
            await installHerdr(np.bin, { platform: ctx.platform, arch: process.arch, from: ctx.env.AGENTBOX_NODE_HERDR_FROM || undefined, log: (s) => ctx.err(s) });
          },
          passphrase: () => askPassphrase(prompt, (s) => ctx.err(s)),
          enrol: (pass) => enrol(pass, ctx.now()),
          sleep: (ms) => sleep(ms, ctx.abort.signal),
          askFolders: async () => {
            ctx.err("Which project folders may the box use? (comma-separated; add :read for read-only; never your whole home)\n");
            const answer = await prompt.line("Folders: ");
            return answer ? parseFolders(answer, home(ctx)) : [];
          },
          service: noService
            ? null
            : async () => {
                try {
                  const r = await installService({ command: execStart(), env: ctx.env });
                  ctx.err(`Registered ${UNIT_NAME} (${r.unitFile}).\n`);
                  if (r.note) ctx.err(`${r.note}\n`);
                } catch (err) {
                  throw new CliError(`${(err as Error).message}\nThe machine is joined; start it with \`agentbox node run\`.`);
                }
              },
          waitOnline: async () => {
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
              const s = await callControl(np.control, np.controlSecret, "status", 2_000);
              if (s?.state === "online") return true;
              await sleep(1_000, ctx.abort.signal);
            }
            return false;
          },
          printPolicy: () => printPolicy(ctx, np),
        },
      );
    } finally {
      prompt.close();
    }
  },
});

const run = command({
  path: ["node", "run"],
  summary: "run the node in the foreground (the service runs this)",
  usage: "",
  ownsInterrupt: true,
  async run(ctx) {
    const np = paths(ctx);
    const log = (line: string): void => {
      ctx.err(`${new Date(ctx.now()).toISOString()} ${line}\n`);
    };
    return runNode({ paths: np, home: home(ctx), version: VERSION, log, signal: ctx.abort.signal });
  },
});

const status = command({
  path: ["node", "status"],
  summary: "whether this machine is joined, linked and paused",
  usage: "",
  json: true,
  async run(ctx) {
    const np = paths(ctx);
    const creds = readCredentials(np.credentials);
    const live = await callControl(np.control, np.controlSecret, "status", 3_000);
    const policy = loadPolicy(np.policy, home(ctx));
    const out = {
      joined: creds !== null,
      box: creds?.box ?? null,
      machineId: creds?.machineId ?? null,
      name: creds?.name ?? null,
      revoked: creds?.revokedAt !== undefined && creds !== null,
      running: live !== null,
      state: live ? live.state : creds ? (creds.revokedAt !== undefined ? "revoked" : "not running") : "not joined",
      paused: policy.policy.paused,
      policyProblem: policy.problem,
      folder: np.dir,
      service: ctx.platform === "linux" ? serviceInstalled(ctx.env) : false,
      herdrSocket: path.join(np.dir, "herdr.sock"),
    };
    if (ctx.json) return ctx.printJson(out);
    if (!creds) {
      ctx.out(`Not joined to a box. Run \`agentbox node join <box>\`.\n`);
      return EXIT.NOT_FOUND;
    }
    ctx.out(`${safeText(out.name ?? "")} (machine ${safeText(out.machineId ?? "")}) at ${safeText(out.box ?? "")}\n`);
    ctx.out(`state: ${safeText(String(out.state))}${out.paused ? " (paused: `agentbox node resume`)" : ""}\n`);
    if (out.policyProblem) ctx.out(`policy: ${safeText(out.policyProblem)} — everything is denied\n`);
    ctx.out(`folder: ${np.dir}\nservice: ${out.service ? UNIT_NAME : "none"}\n`);
  },
});

async function setPause(ctx: Context, paused: boolean): Promise<void> {
  const np = paths(ctx);
  if (!readCredentials(np.credentials)) throw new CliError("this machine has not joined a box", EXIT.NOT_FOUND);
  const live = await callControl(np.control, np.controlSecret, paused ? "pause" : "resume");
  // Not running: the file alone, which the node reads when it starts.
  if (!live) setPaused(np.policy, paused);
  else if (live.ok !== true) throw new CliError(String(live.error ?? "the node refused"));
  ctx.err(paused ? "Paused: the link is down until `agentbox node resume`.\n" : "Resumed.\n");
}

const pause = command({ path: ["node", "pause"], summary: "take the link down until resume", usage: "", run: (ctx) => setPause(ctx, true) });
const resume = command({ path: ["node", "resume"], summary: "bring the link back up", usage: "", run: (ctx) => setPause(ctx, false) });

const leave = command({
  path: ["node", "leave"],
  summary: "leave the box: tell it if it can be reached, and forget this machine's token",
  usage: "",
  async run(ctx) {
    const np = paths(ctx);
    const creds = readCredentials(np.credentials);
    if (!creds) throw new CliError("this machine has not joined a box", EXIT.NOT_FOUND);
    let told = false;
    const live = await callControl(np.control, np.controlSecret, "leave", 10_000);
    if (live) told = live.told === true;
    else if (creds.revokedAt === undefined) {
      // Not running: a link of its own, just long enough to say so.
      const link = new NodeLink({
        box: creds.box,
        token: creds.token,
        machineId: creds.machineId,
        version: VERSION,
        describe: async () => {
          const policy = summarize(loadPolicy(np.policy, home(ctx)));
          return { ...(await gatherSpecs({ binDir: np.bin, policy })), policy };
        },
      });
      link.start();
      const deadline = Date.now() + 10_000;
      while (link.state !== "online" && Date.now() < deadline) await sleep(200);
      told = await link.leave();
      link.stop();
    }
    if (ctx.platform === "linux") await removeService({ env: ctx.env });
    fs.rmSync(np.secrets, { recursive: true, force: true });
    fs.rmSync(np.credentials, { force: true });
    fs.rmSync(np.controlSecret, { force: true });
    ctx.err(told ? `Left ${creds.box}.\n` : `Left here; ${creds.box} could not be told, so it lists this machine until the owner removes it.\n`);
    ctx.err(`Kept ${np.policy} and ${np.bin}.\n`);
  },
});

const logs = command({
  path: ["node", "logs"],
  summary: "the node's log (from the journal)",
  usage: "",
  ownsInterrupt: true,
  options: [{ name: "follow", short: "f", type: "boolean", description: "keep printing new lines" }],
  async run(ctx, p) {
    const args = ["--user", "-u", UNIT_NAME, "-n", "200", "--no-pager", ...(bool(p.options, "follow") ? ["-f"] : [])];
    return new Promise<number>((resolve) => {
      const child = spawn("journalctl", args, { stdio: "inherit" });
      child.on("error", () => {
        ctx.err("journalctl is not available here; run `agentbox node run` in a terminal to see the log.\n");
        resolve(EXIT.FAILURE);
      });
      child.on("exit", (code) => resolve(code ?? EXIT.OK));
      ctx.abort.signal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
    });
  },
});

const passphrase = command({
  path: ["node", "passphrase"],
  summary: "set this machine's copy of the machines passphrase (after it changed on the box)",
  usage: "",
  async run(ctx) {
    const np = paths(ctx);
    const creds = readCredentials(np.credentials);
    if (!creds) throw new CliError("this machine has not joined a box", EXIT.NOT_FOUND);
    const prompt = new Prompter(ctx.io.stdin, ctx.io.stderr);
    try {
      const presence = await enrol(await askPassphrase(prompt, (s) => ctx.err(s)), ctx.now());
      writeCredentials(np.credentials, { ...creds, presence });
    } finally {
      prompt.close();
    }
    ctx.err("This machine now proves presence with the new passphrase.\n");
  },
});

export const NODE_COMMANDS: Command[] = [join, run, status, pause, resume, leave, logs, passphrase];
