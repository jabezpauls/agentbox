import path from "node:path";
import { findOnPath } from "../mount.js";

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
 * The shell for terminals on Windows: PowerShell 7 (`pwsh`) when it is
 * installed, else the Windows PowerShell every Windows has.
 */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const pwsh = findOnPath("pwsh.exe", env, "win32");
  if (pwsh) return pwsh;
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
