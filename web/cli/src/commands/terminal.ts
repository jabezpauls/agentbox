import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bool, str } from "../args.js";
import type { Context } from "../context.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { findOnPath } from "../mount.js";
import { ensureSsh, runForeground } from "./ssh.js";
import { TtydSession } from "../ttyd.js";
import { DETACH_KEYS, runTerminal } from "../terminal.js";
import { command, type Command } from "./types.js";

/** Quote a directory for bash, keeping a leading `~` expandable. */
export function cdCommand(dir: string): string {
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  let target: string;
  if (dir === "~") target = "~";
  else if (dir.startsWith("~/")) target = `~/${quote(dir.slice(2))}`;
  else target = quote(dir);
  // A leading space keeps it out of bash's history (HISTCONTROL=ignorespace,
  // Debian's default via ignoreboth); `clear` leaves a clean screen behind.
  return ` cd -- ${target} && clear\r`;
}

async function connectTerminal(ctx: Context, basePath: string, initialInput?: string): Promise<number> {
  const { name, client } = await ctx.connect();
  const session = new TtydSession(client, basePath);
  if (ctx.io.stdin.isTTY) ctx.err(`Connected to ${name}. Detach with ${DETACH_KEYS}.\n`);
  return runTerminal({
    session,
    stdin: ctx.io.stdin,
    stdout: ctx.io.stdout,
    stderr: ctx.io.stderr,
    proc: process,
    env: ctx.env,
    ...(initialInput ? { initialInput } : {}),
  });
}

const HERDR_INSTALL = "https://herdr.dev/install.sh";
const HERDR_INSTALL_PS = "https://herdr.dev/install.ps1";

/** One line from stdin (a terminal), for a yes/no question. */
function ask(ctx: Context, question: string): Promise<boolean> {
  ctx.err(question);
  return new Promise((resolve) => {
    const stdin = ctx.io.stdin;
    let line = "";
    const onData = (c: Buffer | string): void => {
      line += c.toString();
      if (!line.includes("\n")) return;
      stdin.off("data", onData);
      stdin.pause();
      resolve(/^\s*y(es)?\s*$/i.test(line.split("\n")[0] as string));
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** herdr here: on PATH, or installed now with herdr's own installer if the person says so. */
async function localHerdr(ctx: Context): Promise<string | null> {
  const found = findOnPath("herdr", ctx.env, ctx.platform);
  if (found || !ctx.io.stdin.isTTY) return found;
  const win = ctx.platform === "win32";
  const how = win ? `irm ${HERDR_INSTALL_PS} | iex` : `curl -fsSL ${HERDR_INSTALL} | sh`;
  const yes = await ask(
    ctx,
    "herdr is not installed here. With it, this terminal draws herdr and only what the panes show crosses\n" +
      `the network: faster, and no redraw glitches. Install it now with herdr's installer (${how})? [y/N] `,
  );
  if (!yes) return null;
  const code = win
    ? await runForeground(ctx, "powershell", ["-ExecutionPolicy", "Bypass", "-c", how])
    : await runForeground(ctx, "/bin/sh", ["-c", `curl -fsSL ${HERDR_INSTALL} | sh`]);
  if (code !== 0) {
    ctx.warn(`herdr's installer exited ${code}`);
    return null;
  }
  const home = (win ? ctx.env.USERPROFILE : ctx.env.HOME) || os.homedir();
  return findOnPath("herdr", ctx.env, ctx.platform) ?? [path.join(home, ".local", "bin", "herdr")].find((f) => fs.existsSync(f)) ?? null;
}

export const attach = command({
  path: ["attach"],
  summary: "herdr on the box, in this terminal",
  usage: "[herdr options…]",
  operands: { min: 0, max: Infinity },
  passthrough: true,
  ownsInterrupt: true,
  options: [{ name: "web", type: "boolean", description: "run herdr's TUI on the box and stream the screen (no herdr or SSH needed here)" }],
  details:
    "With herdr installed here: `herdr --remote <box>` over SSH (set up on first use; see `agentbox\n" +
    "ssh-setup`). herdr draws here, and the box's herdr sends only what the panes show. Anything after\n" +
    "`attach` goes to herdr: `agentbox attach --session work`. herdr's own keys detach (Ctrl-b q).\n" +
    `Without it (or with --web): herdr's TUI runs on the box, as /terminal in the browser; ${DETACH_KEYS}\n` +
    "detaches. Either way it is the same session, and it all keeps running.",
  async run(ctx, p) {
    const web = bool(p.options, "web");
    const herdr = web ? null : await localHerdr(ctx);
    if (herdr) {
      let name: string | null = null;
      try {
        name = await ensureSsh(ctx);
      } catch (err) {
        // A box from before the SSH endpoint still attaches, the old way.
        if (!(err instanceof CliError && err.exitCode === EXIT.NOT_FOUND)) throw err;
        ctx.warn(`${err.message}; attaching the old way`);
      }
      if (name) return runForeground(ctx, herdr, ["--remote", name, ...p.operands]);
    } else if (!web) {
      ctx.err(`Tip: install herdr here (${HERDR_INSTALL}) and \`agentbox attach\` draws it locally: smoother, and lighter on the network.\n`);
    }
    if (p.operands.length) throw new UsageError(`herdr's options (${p.operands.join(" ")}) need herdr installed here`);
    return connectTerminal(ctx, "/terminal");
  },
});

export const shell = command({
  path: ["shell"],
  summary: "a bash shell in the box",
  usage: "",
  ownsInterrupt: true,
  options: [{ name: "cwd", type: "string", value: "dir", description: "start in this directory" }],
  details: `A login shell, as /shell in the browser. ${DETACH_KEYS} leaves (the shell is hung up on), as does \`exit\`.`,
  async run(ctx, p) {
    const cwd = str(p.options, "cwd");
    return connectTerminal(ctx, "/shell", cwd ? cdCommand(cwd) : undefined);
  },
});

export const TERMINAL_COMMANDS: Command[] = [attach, shell];
