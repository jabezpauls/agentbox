import fs from "node:fs";
import path from "node:path";
import agentsTemplate from "../../../../images/machine/agents.md";
import { CliError } from "../errors.js";
import { ensurePrivateDir, writePrivate, type NodePaths } from "./paths.js";
import { downloadVerified, replaceFile } from "./update.js";
import { compareVersions, parseVersion } from "./update-verify.js";

/**
 * Claude Code on a machine (the design, "Claude Code on a machine").
 *
 * - **Installed by the node**, pinned: downloaded straight from Anthropic's
 *   release store into `bin/`, its SHA-256 checked against the pin below
 *   (the same pins the signed machines manifest carries: a test keeps
 *   scripts/machines-manifest.mjs in step), when missing or older.
 * - **Its own config folder**, `<node>/claude`, seeded when absent so a
 *   fresh Claude Code goes straight to its prompt (no theme picker, no login
 *   choice, no folder-trust dialog, no `claude-cli://` handler registered in
 *   the owner's desktop). The owner's own `~/.claude` is never touched.
 * - **A `claude` shim**, first on PATH inside the node's herdr, which at each
 *   launch reads `secrets/claude-token` (when this machine was opted in to
 *   the shared sign-in) into `CLAUDE_CODE_OAUTH_TOKEN` for that process
 *   alone, and runs the real binary with `DISABLE_UPDATES=1` and agentbox's
 *   instructions for machines (`agents.md`).
 */

export const CLAUDE_VERSION = "2.1.311";
/** Earlier ones could swap in a stored login's token on a 401. */
export const CLAUDE_MIN_VERSION = "2.1.225";

export const CLAUDE_PINS: Record<string, { path: string; sha256: string; size: number }> = {
  "linux-x64": { path: "linux-x64/claude", sha256: "86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada", size: 293776752 },
  "linux-arm64": { path: "linux-arm64/claude", sha256: "2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3", size: 293658808 },
  "win32-x64": { path: "win32-x64/claude.exe", sha256: "966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680", size: 298870432 },
};

export const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";

export interface ClaudePaths {
  /** The real binary. */
  bin: string;
  /** Which version is in `bin` (written beside it on install). */
  versionFile: string;
  /** CLAUDE_CONFIG_DIR. */
  config: string;
  /** Put first on herdr's PATH. */
  shims: string;
  shim: string;
  agents: string;
  token: string;
}

export function claudePaths(p: NodePaths, platform: NodeJS.Platform = process.platform): ClaudePaths {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  return {
    bin: path.join(p.bin, exe),
    versionFile: path.join(p.bin, "claude.version"),
    config: path.join(p.dir, "claude"),
    shims: path.join(p.dir, "shims"),
    shim: path.join(p.dir, "shims", "claude"),
    agents: path.join(p.dir, "agents.md"),
    token: path.join(p.secrets, "claude-token"),
  };
}

function writeIfAbsent(file: string, contents: string): boolean {
  if (fs.existsSync(file)) return false;
  writePrivate(file, contents);
  return true;
}

/** The config folder's first files, each only when absent (Claude Code rewrites `.claude.json` itself). */
export function seedClaudeConfig(c: ClaudePaths, home: string): void {
  ensurePrivateDir(c.config);
  writeIfAbsent(path.join(c.config, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true, projects: { [home]: { hasTrustDialogAccepted: true } } }, null, 2)}\n`);
  writeIfAbsent(path.join(c.config, "settings.json"), `${JSON.stringify({ disableDeepLinkRegistration: "disable" }, null, 2)}\n`);
}

/** agentbox's instructions for agents on this machine, named for it. */
export function agentsText(machine: string): string {
  return agentsTemplate.replaceAll("{{machine}}", machine.replace(/[^\w.-]/g, ""));
}

/** A string as one POSIX shell word. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Subcommands that take no session flags: run as they are. */
const PLAIN = ["mcp", "config", "doctor", "update", "install", "setup-token", "migrate-installer", "plugin", "-v", "--version", "-h", "--help"];

export function shimText(c: ClaudePaths): string {
  return `#!/bin/sh
# agentbox: Claude Code on this machine. Written by the node; rewritten at
# every start. Reads the shared sign-in (when this machine was given it) at
# each launch, for this process only.
CLAUDE_CONFIG_DIR=${shQuote(c.config)}
DISABLE_UPDATES=1
export CLAUDE_CONFIG_DIR DISABLE_UPDATES
if [ -f ${shQuote(c.token)} ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shQuote(c.token)})"
  export CLAUDE_CODE_OAUTH_TOKEN
fi
if [ ! -x ${shQuote(c.bin)} ]; then
  echo "agentbox: Claude Code is not installed on this machine yet (it is installed by \`agentbox node join\`)." >&2
  exit 127
fi
case "\${1:-}" in
  ${PLAIN.join("|")}) exec ${shQuote(c.bin)} "$@" ;;
esac
exec ${shQuote(c.bin)} --append-system-prompt-file ${shQuote(c.agents)} "$@"
`;
}

/** The shim, agents.md and the config seed, as `node run` writes them at each start. */
export function prepareClaude(c: ClaudePaths, o: { home: string; machine: string }): void {
  seedClaudeConfig(c, o.home);
  writePrivate(c.agents, agentsText(o.machine));
  ensurePrivateDir(c.shims);
  writePrivate(c.shim, shimText(c), 0o700);
}

/** The shared token the gate pushed: written, or (null) removed. */
export function holdToken(c: ClaudePaths, token: string | null): void {
  if (token === null) {
    fs.rmSync(c.token, { force: true });
    return;
  }
  if (!/^[A-Za-z0-9_\-.~+/=]{20,512}$/.test(token)) return;
  writePrivate(c.token, token);
}

/** The version in `bin/`, as installed by the node; `null` when none. */
export function installedClaude(c: ClaudePaths): string | null {
  if (!fs.existsSync(c.bin)) return null;
  try {
    const v = fs.readFileSync(c.versionFile, "utf8").trim();
    return parseVersion(v) ? v : null;
  } catch {
    return null;
  }
}

export interface ClaudeInstallDeps {
  platform: string;
  arch: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
}

/**
 * Claude Code in `bin/`, unless one at least as new as the pin is there
 * (the updater may have put a newer one). Returns the version there.
 */
export async function installClaude(c: ClaudePaths, deps: ClaudeInstallDeps): Promise<string> {
  const have = installedClaude(c);
  const want = parseVersion(CLAUDE_VERSION) as [number, number, number];
  if (have && compareVersions(parseVersion(have) as [number, number, number], want) >= 0) return have;
  const key = `${deps.platform}-${deps.arch}`;
  const pin = CLAUDE_PINS[key];
  if (!pin) throw new CliError(`Claude Code ${CLAUDE_VERSION} has no build for ${deps.platform}/${deps.arch} that this node knows`);
  deps.log?.(`Installing Claude Code ${CLAUDE_VERSION} (about ${Math.round(pin.size / 2 ** 20)} MiB)…\n`);
  const tmp = await downloadVerified(
    deps.fetch ?? globalThis.fetch,
    { url: `${CLAUDE_RELEASES}/${CLAUDE_VERSION}/${pin.path}`, sha256: pin.sha256, size: pin.size },
    c.bin,
    `Claude Code ${CLAUDE_VERSION}`,
  );
  replaceFile(tmp, c.bin);
  writePrivate(c.versionFile, `${CLAUDE_VERSION}\n`);
  return CLAUDE_VERSION;
}

