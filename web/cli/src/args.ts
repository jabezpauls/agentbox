import { UsageError } from "./errors.js";

/**
 * Argument parsing, by a table rather than a library: each command declares
 * its options and how many operands it takes, and one parser applies them the
 * same way everywhere.
 *
 * - `--name value`, `--name=value` and, for single letters, `-n value`;
 * - short booleans combine (`-rf`);
 * - the global options (`--box`, `--json`, `--help`, `--version`) are
 *   accepted before or after the command;
 * - `--` ends options: everything after it is an operand, so a remote file
 *   named `-r` can still be named.
 */

export interface OptionSpec {
  /** The long name, without `--`. */
  name: string;
  short?: string;
  type: "boolean" | "string";
  /** For help: what the value is, e.g. "dir". */
  value?: string;
  description: string;
}

export interface ParsedOptions {
  [name: string]: string | boolean | undefined;
}

export interface Globals {
  box?: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "box", type: "string", value: "name", description: "the box to use, instead of the current one" },
  { name: "json", type: "boolean", description: "print machine-readable JSON (read commands)" },
  { name: "help", short: "h", type: "boolean", description: "show help" },
  { name: "version", short: "V", type: "boolean", description: "print the CLI's version" },
];

/** A command, or a group of them (`files`), as the parser sees it. */
export interface CommandShape {
  /** The words that name it: `["files", "put"]`. */
  path: string[];
  options: OptionSpec[];
  /** Operand count; `max: Infinity` for "one or more". */
  operands: { min: number; max: number };
}

export interface Parsed<C extends CommandShape = CommandShape> {
  command: C | null;
  /** The words given when no command matched them (for "unknown command"). */
  words: string[];
  options: ParsedOptions;
  operands: string[];
  globals: Globals;
}

function findOption(specs: OptionSpec[], long: string | null, short: string | null): OptionSpec | undefined {
  return specs.find((o) => (long !== null ? o.name === long : o.short === short));
}

/**
 * Parse `argv` (without node and the script) against `commands`. Throws a
 * {@link UsageError} for anything it cannot place; the operand count is
 * checked only when help was not asked for, so `agentbox files put --help`
 * works.
 */
export function parseArgs<C extends CommandShape>(argv: string[], commands: C[]): Parsed<C> {
  const globals: Globals = { json: false, help: false, version: false };
  const options: ParsedOptions = {};
  const operands: string[] = [];
  const words: string[] = [];
  let command: C | null = null;
  let endOfOptions = false;

  /** The command the words so far name, if they name one exactly. */
  const match = (): C | null => commands.find((c) => c.path.length === words.length && c.path.every((w, i) => w === words[i])) ?? null;
  /** True when some command's name starts with the words so far plus `word`. */
  const extends_ = (word: string): boolean =>
    commands.some((c) => c.path.length > words.length && words.every((w, i) => c.path[i] === w) && c.path[words.length] === word);

  const specsNow = (): OptionSpec[] => [...GLOBAL_OPTIONS, ...(command?.options ?? [])];

  const set = (spec: OptionSpec, value: string | boolean): void => {
    if (GLOBAL_OPTIONS.includes(spec)) {
      if (spec.name === "box") globals.box = value as string;
      else (globals as unknown as Record<string, boolean>)[spec.name] = value as boolean;
    } else {
      options[spec.name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      const long = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const spec = findOption(specsNow(), long, null);
      if (!spec) throw new UsageError(`unknown option --${long}${command ? ` for \`agentbox ${command.path.join(" ")}\`` : ""}`);
      if (spec.type === "boolean") {
        if (eq !== -1) throw new UsageError(`--${long} takes no value`);
        set(spec, true);
      } else {
        let value: string | undefined;
        if (eq !== -1) value = arg.slice(eq + 1);
        else value = argv[++i];
        if (value === undefined) throw new UsageError(`--${long} needs a value${spec.value ? ` (${spec.value})` : ""}`);
        set(spec, value);
      }
      continue;
    }

    if (!endOfOptions && arg.startsWith("-") && arg.length > 1 && arg !== "-") {
      const letters = arg.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const letter = letters[j] as string;
        const spec = findOption(specsNow(), null, letter);
        if (!spec) throw new UsageError(`unknown option -${letter}${command ? ` for \`agentbox ${command.path.join(" ")}\`` : ""}`);
        if (spec.type === "boolean") {
          set(spec, true);
          continue;
        }
        // A value-taking letter takes the rest of the word, or the next word.
        const rest = letters.slice(j + 1);
        const value = rest !== "" ? rest : argv[++i];
        if (value === undefined) throw new UsageError(`-${letter} needs a value${spec.value ? ` (${spec.value})` : ""}`);
        set(spec, value);
        break;
      }
      continue;
    }

    // A word: part of the command's name while it can be, an operand after.
    if (!endOfOptions && (command === null || operands.length === 0) && extends_(arg)) {
      words.push(arg);
      command = match();
      continue;
    }
    if (command === null) {
      // Nothing is called this: stop here and let the caller say so.
      words.push(arg);
      break;
    }
    operands.push(arg);
  }

  if (command && !globals.help) {
    const { min, max } = command.operands;
    const name = `agentbox ${command.path.join(" ")}`;
    if (operands.length < min) throw new UsageError(`${name}: missing ${min - operands.length === 1 ? "an argument" : "arguments"} (see \`${name} --help\`)`);
    if (operands.length > max) throw new UsageError(`${name}: too many arguments (see \`${name} --help\`)`);
  }
  return { command, words, options, operands, globals };
}

/** The value of a string option, or `undefined`. */
export function str(options: ParsedOptions, name: string): string | undefined {
  const v = options[name];
  return typeof v === "string" ? v : undefined;
}

export function bool(options: ParsedOptions, name: string): boolean {
  return options[name] === true;
}

/** A whole number option within bounds. */
export function int(options: ParsedOptions, name: string, min: number, max: number): number | undefined {
  const v = str(options, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Sizes as people type them: `50M`, `64k`, `1048576`, `2MiB`. */
export function parseSize(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)(i?b)?$/i.exec(raw.trim());
  if (!m) throw new UsageError(`"${raw}" is not a size (e.g. 8M, 512K)`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? "").toLowerCase()] as number;
  return Math.floor(Number(m[1]) * unit);
}
