// The local stack the CLI's end-to-end run talks to: a herdr server on a
// private socket, the compiled bridge serving the built app, ttyd for the
// herdr TUI (/terminal) and a shell (/shell) exactly as docker-compose.yml
// runs them (--check-origin included), and the compiled gate in front of all
// of it, serving the CLI bundle and install script from a folder of its own.
//
// Nothing is a stub: the CLI signs in through the gate's real device flow and
// every byte crosses the gate. State lives in a throwaway directory, and the
// developer's own herdr session is never touched.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const cliDir = path.resolve(here, "..");
const webDir = path.resolve(cliDir, "..");
export const bundle = path.join(cliDir, "dist", "agentbox.mjs");
const bridgeEntry = path.join(webDir, "bridge", "dist", "bridge", "src", "main.js");
const gateEntry = path.join(webDir, "gate", "dist", "main.js");
const staticDir = path.join(webDir, "app", "dist");

export const USER = "e2e";
export const PASSWORD = "e2e-password-1";

/** A port nothing is listening on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export function waitForPort(port, timeoutMs = 20_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) reject(new Error(`nothing came up on port ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function waitForSocket(p, timeoutMs = 20_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(p);
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) reject(new Error(`timed out waiting for ${p}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Where a program is on PATH, or null. */
export function which(cmd) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * The `ssh` service, as images/workspace/agentbox-sshd starts it and from the
 * image's own sshd_config: this user in place of `coder`, a free port in
 * place of 2222, sessions given the box's home. A stub `docker` on the
 * sessions' PATH lets this sshd stand in for the box's host too, for
 * `ssh-setup --via`: `docker exec -i … agentbox-sshd -i` runs `sshd -i`.
 */
function startSshd({ root, home, port, spawnChild }) {
  const sshd = process.env.SSHD || which("sshd") || ["/usr/sbin/sshd", "/usr/bin/sshd"].find((p) => fs.existsSync(p));
  if (!sshd) throw new Error("sshd (OpenSSH's server) is not installed; set SSHD=/path/to/sshd");
  const keys = path.join(home, ".agentbox", "ssh");
  fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
  const hostKey = path.join(keys, "ssh_host_ed25519_key");
  const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "agentbox", "-f", hostKey], { stdio: "inherit" });
  if (keygen.status !== 0) throw new Error("ssh-keygen failed");
  fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".ssh", "authorized_keys"), "", { mode: 0o600 });
  // herdr --remote looks on PATH, then in ~/.local/bin.
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.symlinkSync(which("herdr"), path.join(home, ".local", "bin", "herdr"));

  const config = path.join(root, "sshd_config");
  const hostBin = path.join(root, "host-bin");
  fs.mkdirSync(hostBin);
  fs.writeFileSync(
    path.join(hostBin, "docker"),
    [
      "#!/bin/sh",
      "# docker, as far as `agentbox ssh-setup --via` and its ProxyCommand use it on a host.",
      'case "$1" in',
      "  ps) echo e2e0ssh; exit 0 ;;",
      "  inspect) echo agentbox-e2e; exit 0 ;;",
      '  exec) shift; [ "$1" = -i ] && shift; shift',
      '    case "$1" in',
      `      cat) exec cat '${hostKey}.pub' ;;`,
      `      agentbox-sshd) exec '${sshd}' -i -f '${config}' ;;`,
      "    esac ;;",
      "esac",
      'echo "docker stub: $*" >&2; exit 1',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, "sshd-env.conf"), `SetEnv "HOME=${home}" "PATH=${hostBin}:/usr/local/bin:/usr/bin:/bin"\n`);
  const image = fs.readFileSync(path.resolve(cliDir, "..", "..", "images", "workspace", "sshd_config"), "utf8");
  const text = image
    .replace(/^Port 2222$/m, `Port ${port}`)
    .replace(/^HostKey .*$/m, `HostKey ${hostKey}`)
    .replace(/^AllowUsers coder$/m, `AllowUsers ${os.userInfo().username}`)
    .replace(/^AuthorizedKeysFile .*$/m, `AuthorizedKeysFile ${path.join(home, ".ssh", "authorized_keys")}`)
    .replace(/^Include .*$/m, `Include ${path.join(root, "sshd-env.conf")}`);
  // The state is under the system's world-writable temp folder.
  fs.writeFileSync(config, `StrictModes no\n${text}`);
  spawnChild("sshd", sshd, ["-D", "-e", "-f", config], process.env);
  return { port, user: os.userInfo().username, config, sshd };
}

export async function startStack({ log = () => {} } = {}) {
  for (const [what, p] of [
    ["bridge build", bridgeEntry],
    ["gate build", gateEntry],
    ["app build", staticDir],
    ["CLI bundle", bundle],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`missing ${what} at ${p} — run \`npm run build\` in web/ first`);
  }
  const ttyd = process.env.TTYD || which("ttyd");
  if (!ttyd) throw new Error("ttyd is not on PATH (set TTYD=/path/to/ttyd); the image pins 1.7.7");
  if (!which("herdr")) throw new Error("herdr is not on PATH");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-cli-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const gateData = path.join(root, "gate");
  const gateCli = path.join(root, "gate-cli");
  for (const d of [home, path.join(home, ".config"), path.join(workspace, "demo"), gateData, gateCli]) fs.mkdirSync(d, { recursive: true });
  // The box's herdr, past its first-run tour, which would take the keys and clicks the tests send.
  fs.mkdirSync(path.join(home, ".config", "herdr"));
  fs.writeFileSync(path.join(home, ".config", "herdr", "config.toml"), "onboarding = false\n");
  // What the gate's image carries in /app/cli.
  fs.copyFileSync(bundle, path.join(gateCli, "agentbox.mjs"));
  fs.copyFileSync(path.join(cliDir, "install.sh"), path.join(gateCli, "install"));

  // herdr's default socket for this home, as in the box: the bridge, ttyd's
  // herdr and a herdr reached over SSH all find the same server by it.
  const socketPath = path.join(home, ".config", "herdr", "herdr.sock");
  const sandboxEnv = {
    // Nothing of this desktop's session: herdr keys some paths on XDG_RUNTIME_DIR,
    // which the box has not, and neither has a session over SSH.
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_") && !k.startsWith("XDG_"))),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
  };
  const ports = {
    bridge: await freePort(),
    // The bridge's data plane (apps, tunnels) and the gate's sandbox-side app API.
    data: await freePort(),
    apps: await freePort(),
    terminal: await freePort(),
    shell: await freePort(),
    gate: await freePort(),
    code: await freePort(),
    ssh: await freePort(),
  };

  const children = [];
  const spawnChild = (name, cmd, args, env, cwd = undefined, detached = false) => {
    const child = spawn(cmd, args, { env, cwd, detached, stdio: ["ignore", "pipe", "pipe"] });
    const lines = [];
    const keep = (c) => {
      lines.push(c.toString());
      if (lines.length > 200) lines.shift();
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("exit", (code) => log(`${name} exited (${code})`));
    children.push({ name, child, lines });
    return child;
  };

  // In a session of its own, as the bridge starts it in the box: herdr serves
  // --remote and saved machines only from such a (detached) server.
  spawnChild("herdr", "herdr", ["server"], sandboxEnv, undefined, true);
  await waitForSocket(socketPath);
  spawnChild("bridge", process.execPath, [bridgeEntry], {
    ...sandboxEnv,
    WORKBENCH_PORT: String(ports.bridge),
    WORKBENCH_STATIC_DIR: staticDir,
    WORKBENCH_WORKSPACE_ROOT: workspace,
    WORKBENCH_HOME_ROOT: home,
    WORKBENCH_REVIEW_DIR: path.join(root, "review"),
    WORKBENCH_DATA_PORT: String(ports.data),
    WORKBENCH_DATA_HOST: "127.0.0.1",
    AGENTBOX_GATE_APPS_URL: `http://127.0.0.1:${ports.apps}`,
  });
  // As docker-compose.yml runs them.
  spawnChild("terminal", ttyd, ["--port", String(ports.terminal), "--interface", "127.0.0.1", "--base-path", "/terminal", "--check-origin", "--writable", "herdr"], sandboxEnv);
  // Started in the workspace, as a shell in the box would be.
  spawnChild("shell", ttyd, ["--port", String(ports.shell), "--interface", "127.0.0.1", "--base-path", "/shell", "--check-origin", "--writable", "bash", "-l"], sandboxEnv, workspace);
  const ssh = startSshd({ root, home, port: ports.ssh, spawnChild });
  await Promise.all([waitForPort(ports.bridge), waitForPort(ports.data), waitForPort(ports.terminal), waitForPort(ports.shell), waitForPort(ports.ssh)]);

  const { hashPassword } = await import(path.join(webDir, "gate", "dist", "password.js"));
  spawnChild("gate", process.execPath, [gateEntry], {
    ...process.env,
    GATE_HOST: "127.0.0.1",
    GATE_PORT: String(ports.gate),
    GATE_DATA_DIR: gateData,
    GATE_ADMIN_SOCKET: path.join(root, "gate-admin.sock"),
    GATE_UPSTREAM_HOST: "127.0.0.1",
    GATE_BRIDGE_PORT: String(ports.bridge),
    GATE_DATA_PORT: String(ports.data),
    GATE_APPS_HOST: "127.0.0.1",
    GATE_APPS_PORT: String(ports.apps),
    GATE_TERMINAL_PORT: String(ports.terminal),
    GATE_SHELL_PORT: String(ports.shell),
    GATE_CODE_PORT: String(ports.code),
    GATE_MONITOR_PORT: String(ports.code),
    GATE_CLI_DIR: gateCli,
    AGENTBOX_USER: USER,
    AGENTBOX_PASSWORD_HASH: await hashPassword(PASSWORD, 4),
  });
  await waitForPort(ports.gate);

  return {
    root,
    home,
    workspace,
    gateCli,
    url: `http://127.0.0.1:${ports.gate}`,
    ports,
    ssh,
    logs: () => children.map((c) => `--- ${c.name}\n${c.lines.join("")}`).join("\n"),
    async stop({ keep = false } = {}) {
      for (const { child } of children) child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      if (!keep) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
