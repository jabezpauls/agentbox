import { str } from "../args.js";
import type { Context } from "../context.js";
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

export const attach = command({
  path: ["attach"],
  summary: "herdr's TUI, in this terminal",
  usage: "",
  ownsInterrupt: true,
  details:
    `The same session as /terminal in the browser: every agent and pane. ${DETACH_KEYS} detaches and\n` +
    "leaves it all running; closing herdr itself ends the command.",
  async run(ctx) {
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
