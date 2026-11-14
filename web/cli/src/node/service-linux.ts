import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The node as a systemd **user** service: no root. `Restart=on-failure`, so a
 * crash is restarted and a revocation (which exits 0) is not. Logs go to the
 * journal (`agentbox node logs`).
 *
 * To run while the owner is logged out it needs lingering, which
 * `loginctl enable-linger` grants oneself under default polkit; where it does
 * not, the node runs while the owner is logged in, and `join` says so and
 * offers an `@reboot` crontab line instead.
 */

export const UNIT_NAME = "agentbox-node.service";

export interface Runner {
  (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const runCommand: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function unitDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "systemd", "user");
}

/** Whether Node reports this process as a standalone executable (a SEA). */
export function runningAsSea(): boolean {
  try {
    const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
    return typeof sea?.isSea === "function" && sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Whether this is the standalone executable rather than agentbox.mjs under
 * Node. Ask Node first: in a SEA, `argv[1]` is the name as typed (`agentbox`
 * found on PATH), not its path, so comparing paths alone misses it.
 */
export function isStandalone(execPath: string, script: string | undefined, sea: boolean = runningAsSea()): boolean {
  return sea || script === undefined || path.resolve(script) === path.resolve(execPath);
}

/** How the service starts this same program: the Node running it and its script, or a standalone executable. */
export function execStart(execPath: string = process.execPath, script: string | undefined = process.argv[1], sea: boolean = runningAsSea()): string[] {
  return isStandalone(execPath, script, sea) ? [execPath, "node", "run"] : [execPath, path.resolve(script as string), "node", "run"];
}

function quote(arg: string): string {
  // systemd's own quoting: double quotes, with `\` and `"` escaped; `%` doubled.
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function unitText(command: string[]): string {
  return [
    "[Unit]",
    "Description=agentbox node: this machine's link to its box",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${command.map(quote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    // herdr, and the agents in it, outlive a restart of the node (an
    // update, a crash); the next node adopts it.
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface ServiceResult {
  unitFile: string;
  /** Whether it will run while the owner is logged out. */
  lingering: boolean;
  /** What to tell the owner when it will not. */
  note: string | null;
}

/** Write the unit, start it, and ask for lingering. Throws when systemd's user manager is not there. */
export async function installService(opts: { command: string[]; user?: string; env?: NodeJS.ProcessEnv; run?: Runner }): Promise<ServiceResult> {
  const run = opts.run ?? runCommand;
  const dir = unitDir(opts.env);
  fs.mkdirSync(dir, { recursive: true });
  const unitFile = path.join(dir, UNIT_NAME);
  fs.writeFileSync(unitFile, unitText(opts.command), { mode: 0o644 });
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", UNIT_NAME], ["--user", "restart", UNIT_NAME]]) {
    const r = await run("systemctl", args);
    if (r.code !== 0) {
      throw new Error(`systemctl ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    }
  }
  const user = opts.user ?? os.userInfo().username;
  const linger = await run("loginctl", ["enable-linger", user]);
  if (linger.code === 0) return { unitFile, lingering: true, note: null };
  const cron = `@reboot ${opts.command.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  return {
    unitFile,
    lingering: false,
    note:
      "This machine does not let the node keep running after you log out (loginctl enable-linger was refused), " +
      "so it runs while you are logged in. To start it at boot instead, add this line with `crontab -e`:\n" +
      `    ${cron}`,
  };
}

export async function removeService(opts: { env?: NodeJS.ProcessEnv; run?: Runner } = {}): Promise<boolean> {
  const run = opts.run ?? runCommand;
  const unitFile = path.join(unitDir(opts.env), UNIT_NAME);
  if (!fs.existsSync(unitFile)) return false;
  await run("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
  fs.rmSync(unitFile, { force: true });
  await run("systemctl", ["--user", "daemon-reload"]);
  return true;
}

export function serviceInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(path.join(unitDir(env), UNIT_NAME));
}
