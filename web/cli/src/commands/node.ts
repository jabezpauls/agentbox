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
import { claudePaths, installClaude } from "../node/claude.js";
import { installHerdr } from "../node/install.js";
import { joinMachine } from "../node/join.js";
import { NodeLink } from "../node/link.js";
import { nodeDir, nodePaths, type NodePaths } from "../node/paths.js";
import { askPassphrase, enrol } from "../node/presence.js";
import { Prompter } from "../node/prompt.js";
import { loadPolicy, setPaused, summarize, type FileMode } from "../node/policy.js";
import { runNode } from "../node/run.js";
import { execStart, installService, removeService, serviceInstalled, UNIT_NAME } from "../node/service-linux.js";
import * as win from "../node/service-windows.js";
import { freeBytes, gatherSpecs } from "../node/specs.js";
import { sleep } from "../device.js";
import { command, type Command } from "./types.js";

/**
 * `agentbox node …`: this computer as a machine of a box. See the design,
 * docs/design/2026-11-13-machines-design.md.
 */

function paths(ctx: Context): NodePaths {
  return nodePaths(nodeDir(ctx.env, home(ctx), ctx.platform), ctx.platform);
}

function home(ctx: Context): string {
  // Windows: the profile folder (a HOME from Git Bash may be spelled otherwise).
  if (ctx.platform === "win32") return ctx.env.USERPROFILE || os.homedir();
  return ctx.env.HOME || os.homedir();
}

/** `--folder ~/code,~/notes:read`: comma-separated folders, each `write` unless it says `:read`. */
export function parseFolders(raw: string, homeDir: string): Array<{ path: string; mode: FileMode }> {
  const out: Array<{ path: string; mode: FileMode }> = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)(?::(read|write))?$/.exec(part) as RegExpExecArray;
    let p = m[1] as string;
    if (p === "~") p = homeDir;
    else if (p.startsWith("~/") || (path.sep === "\\" && p.startsWith("~\\"))) p = path.join(homeDir, p.slice(2));
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
    "systemd user service (on Windows, a sign-in entry for your user; no admin).",
  options: [
    { name: "name", type: "string", value: "name", description: "what the box calls this machine (default: the hostname)" },
    { name: "folder", type: "string", value: "dirs", description: "folders the box may use, comma-separated, each dir or dir:read (asked when absent)" },
    { name: "no-service", type: "boolean", description: "do not register a service; run `agentbox node run` yourself" },
    { name: "no-claude", type: "boolean", description: "do not install Claude Code (about 280 MiB); agents can be started once it is there" },
  ],
  async run(ctx, p) {
    const box = normalizeBoxUrl(p.operands[0] as string);
    const np = paths(ctx);
    const prompt = new Prompter(ctx.io.stdin, ctx.io.stderr);
    const folderArg = str(p.options, "folder");
    const noService = bool(p.options, "no-service") || (ctx.platform !== "linux" && ctx.platform !== "win32");
    const registerService = async (): Promise<void> => {
      if (ctx.platform === "win32") {
        const g = win.guiExecutable();
        if ("problem" in g) throw new Error(g.problem);
        await win.installService({ gui: g.gui });
        ctx.err(`Registered the sign-in entry ${win.RUN_KEY}\\${win.RUN_VALUE}; the node runs while you are signed in (log: ${win.logFile(np)}).\n`);
        return;
      }
      const r = await installService({ command: execStart(), env: ctx.env });
      ctx.err(`Registered ${UNIT_NAME} (${r.unitFile}).\n`);
      if (r.note) ctx.err(`${r.note}\n`);
    };
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
            if (!bool(p.options, "no-claude")) await installClaude(claudePaths(np), { platform: ctx.platform, arch: process.arch, log: (s) => ctx.err(s) });
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
                  await registerService();
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
      service: ctx.platform === "linux" ? serviceInstalled(ctx.env) : ctx.platform === "win32" ? (await win.readRunEntry()) !== null : false,
      herdrSocket: typeof live?.herdrSocket === "string" ? live.herdrSocket : null,
      presenceLocked: typeof live?.presenceLocked === "number" ? live.presenceLocked : null,
    };
    if (ctx.json) return ctx.printJson(out);
    if (!creds) {
      ctx.out(`Not joined to a box. Run \`agentbox node join <box>\`.\n`);
      return EXIT.NOT_FOUND;
    }
    ctx.out(`${safeText(out.name ?? "")} (machine ${safeText(out.machineId ?? "")}) at ${safeText(out.box ?? "")}\n`);
    ctx.out(`state: ${safeText(String(out.state))}${out.paused ? " (paused: `agentbox node resume`)" : ""}\n`);
    if (out.policyProblem) ctx.out(`policy: ${safeText(out.policyProblem)} — everything is denied\n`);
    const serviceName = ctx.platform === "win32" ? `${win.RUN_KEY}\\${win.RUN_VALUE}` : UNIT_NAME;
    ctx.out(`folder: ${np.dir}\nservice: ${out.service ? serviceName : "none"}\n`);
    if (out.herdrSocket) ctx.out(`herdr: HERDR_SOCKET_PATH=${out.herdrSocket} herdr   (the agents the box sees)\n`);
    if (out.presenceLocked) ctx.out(`presence: locked until ${new Date(out.presenceLocked).toISOString()} after wrong passphrases\n`);
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
    if (ctx.platform === "win32") await win.removeService({ paths: np });
    fs.rmSync(np.secrets, { recursive: true, force: true });
    fs.rmSync(np.credentials, { force: true });
    fs.rmSync(np.controlSecret, { force: true });
    ctx.err(told ? `Left ${creds.box}.\n` : `Left here; ${creds.box} could not be told, so it lists this machine until the owner removes it.\n`);
    ctx.err(`Kept ${np.policy} and ${np.bin}.\n`);
  },
});

const logs = command({
  path: ["node", "logs"],
  summary: "the node's log (from the journal; on Windows, state\\node.log)",
  usage: "",
  ownsInterrupt: true,
  options: [{ name: "follow", short: "f", type: "boolean", description: "keep printing new lines" }],
  async run(ctx, p) {
    if (ctx.platform === "win32") return tailLog(ctx, win.logFile(paths(ctx)), bool(p.options, "follow"));
    const args = ["--user", "-u", UNIT_NAME, "-n", "200", "--no-pager", ...(bool(p.options, "follow") ? ["-f"] : [])];
    return new Promise<number>((resolve) => {
      const child = spawn("journalctl", args, { stdio: "inherit", windowsHide: true });
      child.on("error", () => {
        ctx.err("journalctl is not available here; run `agentbox node run` in a terminal to see the log.\n");
        resolve(EXIT.FAILURE);
      });
      child.on("exit", (code) => resolve(code ?? EXIT.OK));
      ctx.abort.signal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
    });
  },
});

/** The last 200 lines of the log, and with `follow` what is added (from the start of a rotated one). */
async function tailLog(ctx: Context, file: string, follow: boolean): Promise<number> {
  let at = 0;
  try {
    const text = fs.readFileSync(file, "utf8");
    at = Buffer.byteLength(text);
    ctx.out(`${text.split("\n").slice(-201).join("\n")}`);
  } catch {
    if (!follow) {
      ctx.err(`There is no log yet (${file}); the node writes it when it runs as a service.\n`);
      return EXIT.NOT_FOUND;
    }
  }
  while (follow && !ctx.abort.signal.aborted) {
    await sleep(1_000, ctx.abort.signal).catch(() => {});
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size < at) at = 0;
    if (size === at) continue;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - at);
      fs.readSync(fd, buf, 0, buf.length, at);
      ctx.out(buf.toString("utf8"));
      at = size;
    } finally {
      fs.closeSync(fd);
    }
  }
  return EXIT.OK;
}

/**
 * `agentbox node supervise`, which the Windows sign-in entry runs (as the
 * windowless agentbox-node.exe): keeps `agentbox.exe node run` running.
 */
const supervise = command({
  path: ["node", "supervise"],
  summary: "keep the node running, with its log in state\\node.log (Windows' sign-in entry runs this)",
  usage: "",
  ownsInterrupt: true,
  async run(ctx) {
    return win.supervise({ paths: paths(ctx), command: win.runCommandLine(), signal: ctx.abort.signal });
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
    // A running node takes it now, and ends every grant the old one earned.
    const live = await callControl(np.control, np.controlSecret, "passphrase", 5_000);
    if (live !== null && live.ok !== true) throw new CliError(`the running node did not take it (${String(live.error ?? "refused")}); restart it`);
    ctx.err("This machine now proves presence with the new passphrase.\n");
  },
});

/**
 * `agentbox node preview <port>`, which the node's `agentbox-preview` shim
 * runs (an agent on this machine calls it as the box's agents do): register
 * a port with the running node, for the owner's Preview.
 */
const preview = command({
  path: ["node", "preview"],
  summary: "show an app on this machine in the owner's Preview (agentbox-preview)",
  usage: "<port> | open <port> | list | stop <port>",
  details: [
    "agentbox-preview <port> [--name n]   register a server already listening on <port>",
    "agentbox-preview list                what is registered",
    "agentbox-preview stop <port>         take it off the Preview",
    "",
    "Only registered ports are ever reached, on 127.0.0.1 or [::1]. A registration ends when",
    "the port has not answered for 60 seconds, or when the node restarts. Apps on a machine are",
    "private: the owner opens them from the machines page. `start -- <command>` is not",
    "available on a machine yet: start the server yourself, then register its port.",
  ].join("\n"),
  operands: { min: 1, max: 2 },
  json: true,
  options: [{ name: "name", type: "string", value: "name", description: "what to call it (default: the port)" }],
  async run(ctx, p) {
    const np = paths(ctx);
    const [verb, arg] = p.operands as [string, string | undefined];
    const ask = async (command: "preview" | "preview-list" | "preview-stop", args: Record<string, unknown> = {}) => {
      const r = await callControl(np.control, np.controlSecret, command, 15_000, args);
      if (r === null) throw new CliError("the node is not running on this machine (`agentbox node status`)", EXIT.UNREACHABLE);
      if (r.ok !== true) throw new CliError(String(r.error ?? "the node refused"));
      return r;
    };
    if (verb === "list") {
      const r = await ask("preview-list");
      const apps = Array.isArray(r.apps) ? (r.apps as Array<{ port: number; name: string }>) : [];
      if (ctx.json) return ctx.printJson({ apps });
      if (apps.length === 0) ctx.out("No apps registered on this machine.\n");
      for (const a of apps) ctx.out(`${a.port}\t${safeText(a.name)}\n`);
      return;
    }
    if (verb === "start") throw new UsageError("`start` is not available on a machine yet: start the server yourself, then `agentbox-preview <port>`");
    if (verb === "stop") {
      if (!arg) throw new UsageError("stop needs a port");
      await ask("preview-stop", { port: Number(arg) });
      ctx.err(`Port ${arg} is off the Preview.\n`);
      return;
    }
    const port = verb === "open" ? arg : verb;
    if (!port || !/^\d{1,5}$/.test(port)) throw new UsageError("name a port: agentbox-preview <port>");
    const name = str(p.options, "name");
    const r = await ask("preview", { port: Number(port), ...(name === undefined ? {} : { name }) });
    const app = r.app as { port: number; name: string };
    if (ctx.json) return ctx.printJson({ app, online: r.online === true });
    ctx.err(
      `Port ${app.port} is in the owner's Preview as "${safeText(app.name)}" (the machines page, this machine, Preview).` +
        `${r.online === true ? "" : " The machine is not linked to its box right now; it shows there once it is."}\n`,
    );
  },
});

export const NODE_COMMANDS: Command[] = [join, run, supervise, status, pause, resume, leave, logs, passphrase, preview];
