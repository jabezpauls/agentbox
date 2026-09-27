import type { CommandShape, OptionSpec, Parsed } from "../args.js";
import type { Context } from "../context.js";

/** A command: its name, how it is called, and what it does. */
export interface Command extends CommandShape {
  /** One line for the command list. */
  summary: string;
  /** The operands, for the usage line: `<url>`, `[path]`. */
  usage: string;
  /** More help, shown by `--help`. */
  details?: string;
  /** Prints something worth reading by a program, so `--json` applies. */
  json?: boolean;
  /** Hidden from the command list (still callable). */
  hidden?: boolean;
  /**
   * Ctrl-C is how this command is meant to end (a mount, a terminal): it
   * watches `ctx.abort` and cleans up in its own time. Other commands get a
   * moment to stop, then the process exits.
   */
  ownsInterrupt?: boolean;
  /** Returns the exit code; nothing means success. */
  run(ctx: Context, p: Parsed<Command>): Promise<number | void>;
}

export function command(c: Omit<Command, "options" | "operands"> & { options?: OptionSpec[]; operands?: { min: number; max: number } }): Command {
  return { options: [], operands: { min: 0, max: 0 }, ...c };
}
