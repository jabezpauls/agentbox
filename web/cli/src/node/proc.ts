import path from "node:path";
import { findOnPath } from "../mount.js";
import { writePrivate } from "./paths.js";

/**
 * What the node's children run with.
 *
 * Every child the node starts is spawned with `windowsHide: true`: on
 * Windows, a child of the windowless node without it gets a visible console
 * window (machines spike, question 4). test/node-windows.test.ts reads the
 * node's sources and fails on any spawn that does not say so.
 */

/**
 * `env` with `dirs` first on its PATH. Windows spells the variable `Path`
 * and treats it case-insensitively, so a copy of its environment may hold it
 * under any case: every spelling is folded into one, keeping the one found.
 */
export function withPath(env: NodeJS.ProcessEnv, dirs: string[], platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const keys = Object.keys(out).filter((k) => (platform === "win32" ? k.toUpperCase() === "PATH" : k === "PATH"));
  const key = keys[0] ?? (platform === "win32" ? "Path" : "PATH");
  const was = keys.length ? (out[key] ?? "") : "";
  for (const k of keys) delete out[k];
  out[key] = [...dirs, was].filter(Boolean).join(platform === "win32" ? ";" : ":");
  return out;
}

/**
 * The shell herdr starts in each pane on Windows: `agentbox-shell.cmd`,
 * which puts `dirs` first on PATH and runs `shell`. Named by a herdr config
 * file of the node's own (`HERDR_CONFIG_PATH`, see {@link writeHerdrConfig}).
 *
 * herdr's terminals (portable-pty) build a pane's environment from the
 * node's with the registry's on top, and Windows' PATH there replaces the
 * one the node passed: without this the panes would not find the `claude`
 * and `agentbox-preview` shims. herdr takes an executable for its shell, with
 * no arguments, hence a file.
 */
export function writeShellShim(shims: string, dirs: string[], shell: string): string {
  const q = (s: string): string => s.replace(/%/g, "%%");
  const file = path.join(shims, "agentbox-shell.cmd");
  const text = [
    "@echo off",
    "rem agentbox: the shell of the node's terminals. Written by the node; rewritten at every start.",
    `set "Path=${dirs.map(q).join(";")};%Path%"`,
    `"${q(shell)}" -NoLogo`,
    "",
  ].join("\r\n");
  writePrivate(file, text, 0o700);
  return file;
}

/**
 * The node's herdr's own config file (`HERDR_CONFIG_PATH`), so it never
 * reads or changes the owner's: on Windows it names the pane shell. Returns
 * its path.
 */
export function writeHerdrConfig(file: string, shell: string | null): string {
  // A TOML basic string is a JSON string, for what a path holds.
  const lines = ["# agentbox: the node's own herdr settings. Written by the node; rewritten at every start.", ""];
  if (shell) lines.push("[terminal]", `default_shell = ${JSON.stringify(shell)}`, "");
  writePrivate(file, lines.join("\n"));
  return file;
}

/**
 * The shell for terminals on Windows: PowerShell 7 (`pwsh`) when it is
 * installed, else the Windows PowerShell every Windows has.
 */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const pwsh = findOnPath("pwsh.exe", env, "win32");
  if (pwsh) return pwsh;
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
