import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FilesService, type RootConfig } from "@workbench/hostcore/files";
import type { NodePaths } from "./paths.js";
import type { Policy } from "./policy.js";

/**
 * Files on a machine (the design, "Files on a machine"): the policy's folders
 * as the files API's roots, each `read` or `write`, and two lists the box can
 * never get past, whatever the policy says:
 *
 * - **never writable** (reads allowed unless also hidden): the node's own
 *   folder, shell profiles, autostart locations, `~/.ssh/authorized_keys`,
 *   git's global config — and, beyond the spec's list, every folder on PATH
 *   inside the home folder (`~/.local/bin`: the node itself runs `docker` and
 *   `nvidia-smi` by name), desktop entries, and in any repository
 *   `.git/config` and `.git/hooks`, which git runs from. With `terminals` off
 *   this is what keeps "write a file" from becoming "run code";
 * - **never visible**: `~/.ssh`, `~/.gnupg`, agentbox's own config and the
 *   node's secrets, Claude Code's credentials and the node's
 *   `CLAUDE_CONFIG_DIR`, browser profiles, the Windows credential stores.
 *
 * Both are checked on the resolved real path (the files API resolves every
 * path before it asks), case-insensitively on Windows and macOS. An entry
 * that is itself reached through a link (a dotfiles repo's `~/.bashrc`) is
 * listed as it resolves too, so the link's target is covered as well.
 *
 * On Windows, before any of that, a path is refused outright when it is a UNC
 * or device path (`\\server\share`, `\\.\`, `\\?\`), names an alternate data
 * stream (a `:` after the drive), ends a component in a dot or a space (which
 * Windows strips, so `.bashrc.` would be `.bashrc`), or names a DOS device.
 */

export interface PathRulesOptions {
  home: string;
  nodeDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Resolve each entry through links (off in tests of another platform's lists). */
  resolve?: boolean;
}

export interface PathRules {
  caseInsensitive: boolean;
  hidden: string[];
  writeDenied: string[];
  isHidden(realPath: string): boolean;
  isWriteDenied(realPath: string): boolean;
  refusePath(input: string): string | null;
}

function pathOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The lists, as configured paths (before resolving links). */
export function pathLists(o: PathRulesOptions): { hidden: string[]; writeDenied: string[] } {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const P = pathOf(platform);
  const H = o.home;
  const N = o.nodeDir;
  const j = (...parts: string[]): string => P.join(...parts);
  const nodeSecrets = ["credentials.json", "secrets", "claude", "control.secret", "control.sock", "state"].map((f) => j(N, f));
  // Folders on PATH inside home: a program put there runs the next time anything is run by that name.
  const ci = platform === "win32" || platform === "darwin";
  const fold = (p: string): string => (ci ? P.normalize(p).toLowerCase() : P.normalize(p));
  const home = fold(H);
  const onPath = (env.PATH ?? env.Path ?? "")
    .split(P.delimiter)
    .filter((d) => d !== "" && P.isAbsolute(d) && fold(d) !== home && fold(d).startsWith(home + P.sep));

  if (platform === "win32") {
    const A = env.APPDATA && P.isAbsolute(env.APPDATA) ? env.APPDATA : j(H, "AppData", "Roaming");
    const L = env.LOCALAPPDATA && P.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : j(H, "AppData", "Local");
    return {
      hidden: [
        j(H, ".ssh"),
        j(H, ".gnupg"),
        j(A, "gnupg"),
        j(A, "agentbox"),
        j(H, ".config", "agentbox"),
        ...nodeSecrets,
        j(H, ".claude", ".credentials.json"),
        j(A, "Microsoft", "Credentials"),
        j(L, "Microsoft", "Credentials"),
        j(A, "Microsoft", "Protect"),
        j(L, "Google", "Chrome", "User Data"),
        j(L, "Microsoft", "Edge", "User Data"),
        j(L, "BraveSoftware"),
        j(L, "Chromium"),
        j(L, "Vivaldi"),
        j(A, "Opera Software"),
        j(A, "Mozilla", "Firefox"),
        j(L, "Mozilla", "Firefox"),
      ],
      writeDenied: [
        N,
        ...onPath,
        j(H, "Documents", "PowerShell"),
        j(H, "Documents", "WindowsPowerShell"),
        j(A, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
        j(H, ".gitconfig"),
        j(H, ".config", "git"),
        // Git Bash reads these.
        j(H, ".bashrc"),
        j(H, ".bash_profile"),
        j(H, ".profile"),
        j(H, ".ssh", "authorized_keys"),
      ],
    };
  }

  const configs = [...new Set([env.XDG_CONFIG_HOME && P.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : j(H, ".config"), j(H, ".config")])];
  const inConfig = (...parts: string[]): string[] => configs.map((c) => j(c, ...parts));
  const mac = platform === "darwin" ? j(H, "Library") : null;
  return {
    hidden: [
      j(H, ".ssh"),
      j(H, ".gnupg"),
      ...inConfig("agentbox"),
      ...nodeSecrets,
      j(H, ".claude", ".credentials.json"),
      j(H, ".mozilla"),
      j(H, ".librewolf"),
      j(H, "snap", "firefox"),
      j(H, "snap", "chromium"),
      j(H, ".var", "app", "org.mozilla.firefox"),
      j(H, ".var", "app", "com.google.Chrome"),
      j(H, ".var", "app", "org.chromium.Chromium"),
      j(H, ".var", "app", "com.brave.Browser"),
      ...["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware", "microsoft-edge", "vivaldi", "opera"].flatMap((b) => inConfig(b)),
      ...(mac
        ? [
            j(mac, "Keychains"),
            j(mac, "Cookies"),
            j(mac, "Safari"),
            j(mac, "Application Support", "Google", "Chrome"),
            j(mac, "Application Support", "Firefox"),
            j(mac, "Application Support", "BraveSoftware"),
            j(mac, "Application Support", "Microsoft Edge"),
            j(mac, "Application Support", "Chromium"),
          ]
        : []),
    ],
    writeDenied: [
      N,
      ...onPath,
      j(H, ".local", "bin"),
      j(H, "bin"),
      j(H, ".local", "share", "applications"),
      j(H, ".pam_environment"),
      ...[".bashrc", ".bash_aliases", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".xprofile", ".xsession", ".xinitrc"].map((f) => j(H, f)),
      ...inConfig("fish"),
      ...inConfig("powershell"),
      ...inConfig("systemd", "user"),
      ...inConfig("environment.d"),
      ...inConfig("autostart"),
      ...inConfig("git"),
      j(H, ".ssh", "authorized_keys"),
      j(H, ".gitconfig"),
      ...(mac ? [j(mac, "LaunchAgents")] : []),
    ],
  };
}

/** An entry as it resolves on disk: itself, or its parent resolved (it may not exist yet). */
function resolved(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return null;
    }
  }
}

/** Why Windows would read `input` as something other than a plain path, or `null`. */
export function refuseWindowsPath(input: string): string | null {
  const s = input.replace(/\//g, "\\");
  if (s.startsWith("\\\\")) {
    return /^\\\\[.?]\\/.test(s) || s === "\\\\." || s === "\\\\?" ? "device paths (\\\\.\\, \\\\?\\) are refused" : "network (UNC) paths are refused";
  }
  // `C:` (or `\C:`) may start the path; any other `:` names a stream.
  const rest = s.replace(/^\\?[A-Za-z]:/, "");
  if (rest.includes(":")) return "alternate data streams (a `:` in a name) are refused";
  for (const part of rest.split("\\")) {
    if (part === "" || part === "." || part === "..") continue;
    if (/[. ]$/.test(part)) return "a name ending in a dot or a space is refused";
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(part)) return "DOS device names are refused";
  }
  return null;
}

export function pathRules(o: PathRulesOptions): PathRules {
  const platform = o.platform ?? process.platform;
  const P = pathOf(platform);
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const fold = (p: string): string => {
    const n = P.normalize(p);
    const t = n.length > 1 && n.endsWith(P.sep) && !/^[A-Za-z]:\\$/.test(n) ? n.slice(0, -1) : n;
    return caseInsensitive ? t.toLowerCase() : t;
  };
  const lists = pathLists(o);
  const expand = (list: string[]): string[] => {
    const out = new Set<string>();
    for (const p of list) {
      out.add(p);
      if (o.resolve ?? platform === process.platform) {
        const r = resolved(p);
        if (r) out.add(r);
      }
    }
    return [...out];
  };
  const hidden = expand(lists.hidden);
  const writeDenied = expand(lists.writeDenied);
  const hiddenF = hidden.map(fold);
  const deniedF = writeDenied.map(fold);
  const under = (p: string, list: string[]): boolean => {
    const f = fold(p);
    return list.some((e) => f === e || f.startsWith(e.endsWith(P.sep) ? e : e + P.sep));
  };
  /** `.git/config` or anything in `.git/hooks`, in any repository. */
  const gitRuns = (p: string): boolean => {
    const parts = fold(p).split(P.sep);
    for (let i = 0; i + 1 < parts.length; i++) {
      if (parts[i] === ".git" && (parts[i + 1] === "hooks" || parts[i + 1] === "config")) return true;
    }
    return false;
  };
  return {
    caseInsensitive,
    hidden,
    writeDenied,
    isHidden: (p) => under(p, hiddenF),
    isWriteDenied: (p) => under(p, deniedF) || gitRuns(p),
    refusePath: (input) => (platform === "win32" ? refuseWindowsPath(input) : null),
  };
}

/** A root's id: the same for the same folder, policy edit after policy edit (the trash names it). */
export function rootId(folder: string): string {
  return `r${createHash("sha256").update(folder).digest("hex").slice(0, 12)}`;
}

/** The files service for the policy's folders; `null` when it allows none. */
export function filesFor(policy: Policy, paths: NodePaths, rules: PathRules): FilesService | null {
  if (policy.files.length === 0) return null;
  const roots: RootConfig[] = policy.files.map((f) => {
    const id = rootId(f.path);
    // Kept in the node's folder, not in the owner's (`<root>/.agentbox`).
    return { id, path: f.path, mode: f.mode, stateDir: path.join(paths.state, "files", id) };
  });
  return new FilesService({
    roots,
    caseInsensitive: rules.caseInsensitive,
    isHidden: rules.isHidden,
    isWriteDenied: rules.isWriteDenied,
    refusePath: rules.refusePath,
  });
}

/** Trashed things are kept this long. */
export const TRASH_DAYS = 7;
