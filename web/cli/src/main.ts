import { parseArgs } from "./args.js";
import { COMMANDS, commandHelp, groupHelp, mainHelp } from "./commands/index.js";
import { ConfigStore, configDir } from "./config.js";
import { Context, defaultIo, type Io } from "./context.js";
import { CliError, EXIT, UsageError } from "./errors.js";
import { safeLines } from "./format.js";
import { VERSION } from "./version.js";

export interface RunDeps {
  io?: Io;
  env?: NodeJS.ProcessEnv;
  /** Where the configuration lives (tests use a directory of their own). */
  configDir?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Hook SIGINT, SIGTERM and SIGHUP (the real CLI does; tests do not). */
  signals?: boolean;
  /** Stands in for Ctrl-C (tests). */
  signal?: AbortSignal;
}

const LOCAL_ERRORS: Record<string, string> = {
  ENOENT: "no such file or folder",
  EACCES: "permission denied",
  EPERM: "not permitted",
  EISDIR: "is a folder",
  ENOTDIR: "a part of the path is not a folder",
  EEXIST: "already exists",
  ENOSPC: "no space left on this device",
  EROFS: "read-only file system",
  EMFILE: "too many open files",
  EBUSY: "busy",
  ENOTEMPTY: "the folder is not empty",
  ELOOP: "too many levels of symbolic links",
  ENAMETOOLONG: "the name is too long",
};

/** A local file-system failure (`ENOENT: …, open 'x'`) as a sentence and an exit code; `null` for anything else. */
export function describeLocalError(err: unknown): { message: string; code: number } | null {
  const e = err as NodeJS.ErrnoException | null;
  if (!e || typeof e.code !== "string" || !(e.code in LOCAL_ERRORS)) return null;
  const what = LOCAL_ERRORS[e.code] as string;
  return { message: e.path ? `${e.path}: ${what}` : `${what} (${e.syscall ?? e.code})`, code: e.code === "ENOENT" ? EXIT.NOT_FOUND : EXIT.FAILURE };
}

/** How long a command that does not own Ctrl-C gets to stop on its own. */
const INTERRUPT_GRACE_MS = 1500;

/** Run one invocation; resolves with its exit code. Never throws. */
export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo();
  const env = deps.env ?? process.env;
  // Messages carry text from the box (paths, names, its own error strings):
  // shown with control characters escaped, so none of it acts on the terminal.
  const fail = (message: string, code: number): number => {
    io.stderr.write(`agentbox: ${safeLines(message)}\n`);
    return code;
  };

  let parsed;
  try {
    parsed = parseArgs(argv, COMMANDS);
  } catch (err) {
    if (err instanceof UsageError) return fail(err.message, EXIT.USAGE);
    throw err;
  }
  const { command, globals } = parsed;

  if (!command) {
    if (globals.version) {
      io.stdout.write(globals.json ? `${JSON.stringify({ version: VERSION })}\n` : `agentbox ${VERSION}\n`);
      return EXIT.OK;
    }
    if (parsed.words.length === 0) {
      io.stdout.write(mainHelp());
      return EXIT.OK;
    }
    const group = groupHelp(parsed.words);
    if (group) {
      (globals.help ? io.stdout : io.stderr).write(group);
      return globals.help ? EXIT.OK : EXIT.USAGE;
    }
    return fail(`unknown command "${parsed.words.join(" ")}"; see \`agentbox --help\``, EXIT.USAGE);
  }
  if (globals.help) {
    io.stdout.write(commandHelp(command));
    return EXIT.OK;
  }
  if (globals.json && !command.json) {
    return fail(`--json is for commands that print something to read; \`agentbox ${command.path.join(" ")}\` does not`, EXIT.USAGE);
  }

  const config = new ConfigStore(deps.configDir ?? configDir(env), { warn: (m) => io.stderr.write(`warning: ${m}\n`) });
  const ctx = new Context(io, env, config, globals, deps.platform ?? process.platform, deps.now ?? Date.now);

  const onSignal = (signal: string): void => {
    // Ctrl-C while the person's editor runs is the editor's (see files edit).
    if (signal === "SIGINT" && ctx.interruptsHeld > 0) return;
    if (ctx.abort.signal.aborted) process.exit(EXIT.INTERRUPTED);
    ctx.abort.abort();
    if (!command.ownsInterrupt) setTimeout(() => process.exit(EXIT.INTERRUPTED), INTERRUPT_GRACE_MS).unref();
  };
  const signals = deps.signals === true ? ["SIGINT", "SIGTERM", "SIGHUP"] : [];
  for (const s of signals) process.on(s, onSignal);
  deps.signal?.addEventListener("abort", () => ctx.abort.abort(), { once: true });

  try {
    const code = await command.run(ctx, parsed);
    return code ?? EXIT.OK;
  } catch (err) {
    if (err instanceof CliError) return fail(err.message, err.exitCode);
    if (ctx.abort.signal.aborted) return fail("interrupted", EXIT.INTERRUPTED);
    // A file here that is missing, or not ours to write: a plain message, no stack.
    const local = describeLocalError(err);
    if (local) return fail(local.message, local.code);
    return fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, EXIT.FAILURE);
  } finally {
    for (const s of signals) process.off(s, onSignal);
    ctx.close();
  }
}
