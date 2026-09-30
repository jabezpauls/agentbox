import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bool, str } from "../args.js";
import { hasBox, type BoxEntry } from "../config.js";
import type { Context } from "../context.js";
import { ApiError, CliError, EXIT, UsageError } from "../errors.js";
import { FilesApi } from "../files-api.js";
import type { BoxClient } from "../http.js";
import { findOnPath } from "../mount.js";
import {
  addAuthorizedKey,
  currentBlock,
  FIND_PROJECTS,
  fingerprint,
  hostKeyAlias,
  KNOWN_HOSTS_FILE,
  OWN_KEY,
  parsePublicKey,
  pinHostKey,
  projectWithKey,
  REMOTE_AUTHORIZED_KEYS,
  REMOTE_HOST_KEY,
  renderBlock,
  SSH_HOST,
  SSH_PORT,
  SSH_USER,
  tunnelProxy,
  upsertBlock,
  viaProxy,
  type PublicKey,
} from "../ssh.js";
import { openTunnel, type TunnelTarget } from "../tunnel.js";
import { command, type Command } from "./types.js";

/**
 * The box as a native SSH host: `ssh-setup` makes `ssh <box>` work (a key,
 * the box's `authorized_keys`, a pinned host key, a managed block in
 * `~/.ssh/config`), and everything that speaks OpenSSH — herdr's `--remote`
 * and saved machines, editors' Remote-SSH, rsync — rides on it.
 */

type Via = NonNullable<BoxEntry["sshVia"]>;

/** The person's home here. `$HOME` first, so tests (and odd setups) can point it elsewhere. */
function homeDir(ctx: Context): string {
  return (ctx.platform === "win32" ? ctx.env.USERPROFILE : ctx.env.HOME) || os.homedir();
}

export function sshDir(ctx: Context): string {
  return path.join(homeDir(ctx), ".ssh");
}

/** How ssh should start this CLI: the installed launcher itself, or node and the script. */
function cliCommand(platform: NodeJS.Platform): string[] {
  const script = path.resolve(process.argv[1] ?? "agentbox");
  if (platform !== "win32") {
    try {
      fs.accessSync(script, fs.constants.X_OK);
      if (fs.readFileSync(script, "utf8").startsWith("#!")) return [script];
    } catch {
      // not a launcher
    }
  }
  return [process.execPath, script];
}

/** Tests put the box's sshd on a port and account of their own. */
function sshUser(ctx: Context): string {
  return ctx.env.AGENTBOX_SSH_USER || SSH_USER;
}

function sshPort(ctx: Context): number {
  const p = Number(ctx.env.AGENTBOX_SSH_PORT || SSH_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : SSH_PORT;
}

function readIfThere(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Show a path under the home as `~/…`. */
function tilde(ctx: Context, p: string): string {
  const home = homeDir(ctx);
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * ssh's own options, when `~/.ssh/config` here is not the one ssh reads by
 * itself (ssh finds it from the password database, not `$HOME`).
 */
export function sshConfigArgs(ctx: Context): string[] {
  const mine = path.join(sshDir(ctx), "config");
  let own: string;
  try {
    own = path.join(os.userInfo().homedir, ".ssh", "config");
  } catch {
    return [];
  }
  return path.resolve(own) === path.resolve(mine) ? [] : ["-F", mine];
}

interface LocalKey {
  file: string;
  key: PublicKey;
}

/** The key to use, if there is one already: the person's own ed25519 key, else agentbox's. */
function existingKey(dir: string): LocalKey | null {
  for (const name of ["id_ed25519", OWN_KEY]) {
    const file = path.join(dir, name);
    const pub = readIfThere(`${file}.pub`);
    const key = pub ? parsePublicKey(pub) : null;
    if (key && fs.existsSync(file)) return { file, key };
  }
  return null;
}

function createKey(ctx: Context, dir: string): LocalKey {
  const file = path.join(dir, OWN_KEY);
  const keygen = findOnPath("ssh-keygen", ctx.env, ctx.platform);
  if (!keygen) throw new CliError("ssh-keygen is not on PATH; install OpenSSH's client and run `agentbox ssh-setup` again");
  const r = spawnSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", `agentbox@${os.hostname()}`, "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const key = r.status === 0 ? parsePublicKey(readIfThere(`${file}.pub`) ?? "") : null;
  if (!key) throw new CliError(`ssh-keygen could not make ${file}: ${(r.stderr || r.error?.message || "").trim()}`);
  return { file, key };
}

function writePrivate(file: string, text: string): void {
  // An existing file keeps its mode (and a symlinked ~/.ssh/config its link).
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/** The block this CLI writes for `box`, given the key and the path it uses. */
function blockFor(ctx: Context, box: string, identityFile: string, via: Via | undefined): string {
  return renderBlock({
    box,
    user: sshUser(ctx),
    proxy: via ? viaProxy(via.host, via.project, sshConfigArgs(ctx)) : tunnelProxy(cliCommand(ctx.platform), sshPort(ctx), box),
    identityFile,
    knownHostsFile: path.join(sshDir(ctx), KNOWN_HOSTS_FILE),
    platform: ctx.platform,
  });
}

/** Which compose project on `host` is the box whose sshd has `hostKey`. */
function findProject(ctx: Context, host: string, box: string, hostKey: PublicKey): string {
  const bin = findOnPath("ssh", ctx.env, ctx.platform);
  if (!bin) throw new CliError("ssh is not on PATH; install OpenSSH's client");
  ctx.err(`Looking for ${box} on ${host} (ssh ${host}, then docker there)…\n`);
  const r = spawnSync(bin, [...sshConfigArgs(ctx), "-T", "-o", "ClearAllForwardings=yes", "--", host, FIND_PROJECTS], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: ctx.env,
    timeout: 60_000,
  });
  if (r.status !== 0) throw new CliError(`\`ssh ${host}\` did not work (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}); --via needs a host you can already ssh to`);
  const project = projectWithKey(r.stdout, hostKey);
  if (!project) {
    throw new CliError(`no agentbox on ${host} has ${box}'s host key; is ${host} the box's host, is its ssh service running, and can your account there run docker?`);
  }
  return project;
}

/**
 * Make `ssh <box>` work; idempotent. `via`: a host to go through (and find
 * the box on), `null` for the gate's tunnel again, `undefined` to keep what
 * was chosen before. Returns one line per thing it changed.
 */
export async function setupSsh(ctx: Context, box: string, client: BoxClient, via?: string | null): Promise<string[]> {
  const files = new FilesApi(client);
  const changes: string[] = [];

  // The box's host key first: a box without the SSH endpoint is said before anything here changes.
  let hostKey: PublicKey | null;
  try {
    hostKey = parsePublicKey(await (await files.raw(REMOTE_HOST_KEY)).text());
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new CliError(`${box} has no SSH endpoint yet (no ${REMOTE_HOST_KEY}); update the box, then run \`agentbox ssh-setup\``, EXIT.NOT_FOUND);
    }
    throw err;
  }
  if (!hostKey) throw new CliError(`${box}'s host key (${REMOTE_HOST_KEY}) is not a public key this CLI reads`);

  const stored = ctx.config.load().boxes;
  const before = hasBox(stored, box) ? stored[box]?.sshVia : undefined;
  let route: Via | undefined = before;
  if (via === null) route = undefined;
  else if (via !== undefined) {
    if (!SSH_HOST.test(via)) throw new UsageError(`"${via}" is not an ssh host: give a Host from ~/.ssh/config, or user@host`);
    route = { host: via, project: findProject(ctx, via, box, hostKey) };
  }
  if (JSON.stringify(route) !== JSON.stringify(before)) {
    ctx.config.update((d) => {
      const entry = hasBox(d.boxes, box) ? d.boxes[box] : undefined;
      if (!entry) return;
      if (route) entry.sshVia = route;
      else delete entry.sshVia;
    });
    changes.push(route ? `reaching ${box} through ${route.host} (compose project ${route.project})` : `reaching ${box} through its HTTPS tunnel`);
  }

  const dir = sshDir(ctx);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let local = existingKey(dir);
  if (!local) {
    local = createKey(ctx, dir);
    changes.push(`created the key ${tilde(ctx, local.file)} (no passphrase)`);
  }

  // The box's sshd makes authorized_keys (0600) when it starts, and a write keeps that mode.
  const remote = await files.stat(REMOTE_AUTHORIZED_KEYS);
  if (!remote) throw new CliError(`${box} has no ${REMOTE_AUTHORIZED_KEYS}; restart its ssh service, or update the box`, EXIT.NOT_FOUND);
  const had = await (await files.raw(REMOTE_AUTHORIZED_KEYS)).text();
  const auth = addAuthorizedKey(had, local.key);
  if (auth.added) {
    await files.write(REMOTE_AUTHORIZED_KEYS, auth.text, true);
    changes.push(`added ${tilde(ctx, local.file)}.pub to ${REMOTE_AUTHORIZED_KEYS} on ${box}`);
  }

  const knownHosts = path.join(dir, KNOWN_HOSTS_FILE);
  const pin = pinHostKey(readIfThere(knownHosts) ?? "", hostKeyAlias(box), hostKey);
  if (pin.status !== "unchanged") {
    writePrivate(knownHosts, pin.text);
    changes.push(`${pin.status === "added" ? "pinned" : "re-pinned (it changed)"} ${box}'s host key ${fingerprint(hostKey)} in ${tilde(ctx, knownHosts)}`);
  }

  const configFile = path.join(dir, "config");
  const cfg = upsertBlock(readIfThere(configFile) ?? "", box, blockFor(ctx, box, local.file, route));
  if (cfg.status !== "unchanged") {
    writePrivate(configFile, cfg.text);
    changes.push(`${cfg.status} \`Host ${box}\` in ${tilde(ctx, configFile)}`);
  }
  return changes;
}

/** Whether `ssh <box>` is set up as this CLI would set it up, judged here without asking the box. */
function isSetUp(ctx: Context, box: string, entry: BoxEntry): boolean {
  const dir = sshDir(ctx);
  const local = existingKey(dir);
  if (!local) return false;
  const pinned = (readIfThere(path.join(dir, KNOWN_HOSTS_FILE)) ?? "").split("\n").some((l) => l.split(/\s+/)[0] === hostKeyAlias(box));
  return pinned && currentBlock(readIfThere(path.join(dir, "config")) ?? "", box) === blockFor(ctx, box, local.file, entry.sshVia);
}

/** Set up SSH for the selected box when it is not already; says what changed, on stderr. */
export async function ensureSsh(ctx: Context): Promise<string> {
  const { name, box, client } = await ctx.connect();
  if (isSetUp(ctx, name, box)) return name;
  for (const line of await setupSsh(ctx, name, client)) ctx.err(`ssh-setup: ${line}\n`);
  return name;
}

/** Run a program in this terminal, Ctrl-C its alone; resolves with its exit code. */
export function runForeground(ctx: Context, file: string, args: string[]): Promise<number> {
  return ctx.holdInterrupts(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(file, args, { stdio: "inherit", env: ctx.env });
        child.once("error", (err) => reject(new CliError(`could not start ${file}: ${err.message}`)));
        child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
      }),
  );
}

export const VIA_OPTIONS = [
  { name: "via", type: "string" as const, value: "host", description: "reach the box's sshd through its host (ssh <host>, then docker there), not the HTTPS tunnel" },
  { name: "tunnel", type: "boolean" as const, description: "reach it through the HTTPS tunnel again (the default)" },
];

/** `--via`/`--tunnel` as {@link setupSsh} takes them. */
export function viaOption(options: Record<string, string | boolean | undefined>): string | null | undefined {
  const via = str(options, "via");
  if (via !== undefined && bool(options, "tunnel")) throw new UsageError("--via and --tunnel are two different ways; give one");
  return via ?? (bool(options, "tunnel") ? null : undefined);
}

export const sshSetup = command({
  path: ["ssh-setup"],
  summary: "make `ssh <box>` work here (key, host key, ~/.ssh/config)",
  usage: "",
  options: VIA_OPTIONS,
  details:
    "Uses ~/.ssh/id_ed25519 if you have one, else makes ~/.ssh/agentbox_ed25519; adds it to the box's\n" +
    "~/.ssh/authorized_keys; pins the box's host key in ~/.ssh/agentbox_known_hosts; and writes a marked\n" +
    "`Host <box>` block at the top of ~/.ssh/config. By default its ProxyCommand is\n" +
    "`agentbox proxy tcp:2222`, through the box's HTTPS address and this device's sign-in. With\n" +
    "--via <host>, a host you can already ssh to (and run docker on), it goes through the host instead:\n" +
    "faster, and one SSH port for every box on it. Safe to run again; `agentbox login` runs it.",
  async run(ctx, p) {
    const via = viaOption(p.options);
    const { name, client } = await ctx.connect();
    const changes = await setupSsh(ctx, name, client, via);
    for (const line of changes) ctx.out(`${line}\n`);
    ctx.out(changes.length ? `\`ssh ${name}\` reaches the box.\n` : `Nothing to change: \`ssh ${name}\` reaches the box.\n`);
  },
});

/** `tcp:<port>` or `herdr`. */
export function parseTarget(raw: string): TunnelTarget {
  if (raw === "herdr") return { kind: "herdr" };
  const m = /^tcp:(\d{1,5})$/.exec(raw);
  const port = Number(m?.[1]);
  if (!m || port < 1 || port > 65535) throw new UsageError(`"${raw}" is not a tunnel target: give tcp:<port> or herdr`);
  return { kind: "tcp", port };
}

export const proxy = command({
  path: ["proxy"],
  summary: "stdin and stdout, joined to a port in the box (ssh's ProxyCommand)",
  usage: "<tcp:port|herdr>",
  operands: { min: 1, max: 1 },
  ownsInterrupt: true,
  details: "What `ssh <box>` runs to reach the box: `agentbox proxy tcp:2222 --box <box>`. Writes nothing but the bytes.",
  async run(ctx, p) {
    const target = parseTarget(p.operands[0] as string);
    // No version check: nothing may delay or print around the bytes.
    const { client } = await ctx.connect({ checkVersion: false });
    const tunnel = await openTunnel(client, target);
    const { stdin, stdout } = ctx.io;
    try {
      await new Promise<void>((resolve, reject) => {
        tunnel.on("data", (chunk: Buffer) => {
          if (!stdout.write(chunk) && stdout.once) {
            tunnel.pause();
            stdout.once("drain", () => tunnel.resume());
          }
        });
        stdin.pipe(tunnel);
        tunnel.once("error", reject);
        tunnel.once("close", () => resolve());
        ctx.abort.signal.addEventListener("abort", () => tunnel.destroy(), { once: true });
      });
    } finally {
      stdin.unpipe(tunnel);
    }
  },
});

export const ssh = command({
  path: ["ssh"],
  summary: "ssh into the box, or run a command there",
  usage: "[command…]",
  operands: { min: 0, max: Infinity },
  passthrough: true,
  ownsInterrupt: true,
  details: "`ssh <box> [command…]`, setting SSH up first if it is not. For ssh's own options, run `ssh <box>` itself.",
  async run(ctx, p) {
    const name = await ensureSsh(ctx);
    const bin = findOnPath("ssh", ctx.env, ctx.platform);
    if (!bin) throw new CliError("ssh is not on PATH; install OpenSSH's client");
    return runForeground(ctx, bin, [...sshConfigArgs(ctx), "--", name, ...p.operands]);
  },
});

export const SSH_COMMANDS: Command[] = [sshSetup, ssh, proxy];
