import { GLOBAL_OPTIONS, type OptionSpec } from "../args.js";
import { EXIT } from "../errors.js";
import { VERSION } from "../version.js";
import { AUTH_COMMANDS } from "./auth.js";
import { FILES_COMMANDS } from "./files.js";
import { STATUS_COMMANDS } from "./status.js";
import { TERMINAL_COMMANDS } from "./terminal.js";
import type { Command } from "./types.js";

/**
 * Every command, in the order `agentbox --help` lists them. Still to come,
 * with the box's app registry and herdr tunnel (see tunnel.ts): `herdr call`
 * and `herdr socket` (target `herdr`), and `apps ls|open|share|unshare|forward`
 * over `/api/apps` and `/_gate/apps/:id/visibility`.
 */
export const COMMANDS: Command[] = [
  ...AUTH_COMMANDS,
  ...STATUS_COMMANDS,
  ...TERMINAL_COMMANDS,
  ...FILES_COMMANDS,
];

function optionLine(o: OptionSpec): string {
  const flag = `${o.short ? `-${o.short}, ` : "    "}--${o.name}${o.value ? ` <${o.value}>` : ""}`;
  return `  ${flag.padEnd(26)} ${o.description}`;
}

export function mainHelp(): string {
  const width = Math.max(...COMMANDS.filter((c) => !c.hidden).map((c) => c.path.join(" ").length));
  const lines = COMMANDS.filter((c) => !c.hidden).map((c) => `  ${c.path.join(" ").padEnd(width)}  ${c.summary}`);
  return [
    `agentbox ${VERSION} — your agentbox, from this machine`,
    "",
    "Usage: agentbox <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Options for every command:",
    ...GLOBAL_OPTIONS.map(optionLine),
    "",
    "Start with `agentbox login https://your-box`. `agentbox <command> --help` says more.",
    `Exit codes: ${EXIT.OK} ok, ${EXIT.FAILURE} failed, ${EXIT.USAGE} usage, ${EXIT.AUTH} not signed in, ${EXIT.NOT_FOUND} not found, ${EXIT.UNREACHABLE} box unreachable, ${EXIT.INTERRUPTED} interrupted.`,
    "",
  ].join("\n");
}

export function commandHelp(c: Command): string {
  const opts = c.options.length ? ["", "Options:", ...c.options.map(optionLine)] : [];
  const globals = GLOBAL_OPTIONS.filter((o) => o.name !== "json" || c.json).map(optionLine);
  return [
    `Usage: agentbox ${c.path.join(" ")}${c.options.length ? " [options]" : ""}${c.usage ? ` ${c.usage}` : ""}`,
    "",
    `${c.summary[0]?.toUpperCase()}${c.summary.slice(1)}.`,
    ...(c.details ? ["", c.details] : []),
    ...opts,
    "",
    "Global options:",
    ...globals,
    "",
  ].join("\n");
}

/** Help for a group of commands (`agentbox files`). */
export function groupHelp(prefix: string[]): string | null {
  const members = COMMANDS.filter((c) => !c.hidden && prefix.every((w, i) => c.path[i] === w) && c.path.length > prefix.length);
  if (members.length === 0) return null;
  const width = Math.max(...members.map((c) => c.path.join(" ").length));
  return [
    `Usage: agentbox ${prefix.join(" ")} <command> [options]`,
    "",
    ...members.map((c) => `  ${c.path.join(" ").padEnd(width)}  ${c.summary}`),
    "",
    `\`agentbox ${prefix.join(" ")} <command> --help\` says more.`,
    "",
  ].join("\n");
}
