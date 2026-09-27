import { parseArgs } from "./args.js";
import { COMMANDS, commandHelp, groupHelp, mainHelp } from "./commands/index.js";
import { ConfigStore, configDir } from "./config.js";
import { Context, defaultIo, type Io } from "./context.js";
import { CliError, EXIT, UsageError } from "./errors.js";
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

/** How long a command that does not own Ctrl-C gets to stop on its own. */
const INTERRUPT_GRACE_MS = 1500;

/** Run one invocation; resolves with its exit code. Never throws. */
export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo();
  const env = deps.env ?? process.env;
  const fail = (message: string, code: number): number => {
    io.stderr.write(`agentbox: ${message}\n`);
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

  const onSignal = (): void => {
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
    return fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, EXIT.FAILURE);
  } finally {
    for (const s of signals) process.off(s, onSignal);
    ctx.close();
  }
}
