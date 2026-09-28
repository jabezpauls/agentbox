#!/usr/bin/env node
// Boot the real thing for the end-to-end tests: a herdr server on a private
// socket, then the compiled bridge serving the built app against it, and the
// compiled gate in front of both.
//
// Nothing here is a stub. The tests drive the same binary the image ships and
// the same bridge build the image copies in, so a break in either shows up
// here rather than on someone's VPS. State lives in a throwaway directory that
// is removed when this process exits, and the herdr server dies with it — the
// developer's own herdr session is never touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const bridgeEntry = path.resolve(appDir, "../bridge/dist/bridge/src/main.js");
const gateEntry = path.resolve(appDir, "../gate/dist/main.js");
const staticDir = path.resolve(appDir, "dist");
const port = Number(process.env.WORKBENCH_PORT ?? 7800);
// The bridge's data plane (apps, tunnels) and the gate's sandbox-side app API.
const dataPort = Number(process.env.WORKBENCH_DATA_PORT ?? port + 1);
const gatePort = Number(process.env.GATE_PORT ?? 7900);
const appsPort = Number(process.env.GATE_APPS_PORT ?? gatePort + 1);

for (const [what, p] of [["bridge build", bridgeEntry], ["gate build", gateEntry], ["app build", staticDir]]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${what} at ${p} — run \`npm run build\` first`);
    process.exit(1);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-e2e-"));
const home = path.join(root, "home");
// The workspace root, where servers count as apps rather than the host's own;
// a suite that brings its own projects names it (the fidelity suite does).
const workspaces = process.env.E2E_WORKSPACES ?? path.join(root, "workspaces");
const reviewDir = path.join(root, "review");
fs.mkdirSync(path.join(home, ".config"), { recursive: true });
// Two subdirectories so the new-workspace picker has something to show.
fs.mkdirSync(path.join(workspaces, "demo"), { recursive: true });
fs.mkdirSync(path.join(workspaces, "other"), { recursive: true });
// Review sessions land here rather than in the developer's own ~/.agentbox.
fs.mkdirSync(reviewDir, { recursive: true });

const socketPath = path.join(root, "herdr.sock");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  HERDR_SOCKET_PATH: socketPath,
  SHELL: "/bin/bash",
};

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(code ?? 0);
  }, 500).unref?.();
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));

function waitForSocket(p, timeoutMs) {
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

const herdr = spawn("herdr", ["server"], { env, stdio: ["ignore", "inherit", "inherit"] });
children.push(herdr);
herdr.on("error", (err) => {
  console.error("could not start herdr — is it on PATH?", err.message);
  stop(1);
});

await waitForSocket(socketPath, 20_000);

const bridge = spawn(process.execPath, [bridgeEntry], {
  env: {
    ...env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_STATIC_DIR: staticDir,
    WORKBENCH_WORKSPACE_ROOT: workspaces,
    WORKBENCH_REVIEW_DIR: reviewDir,
    // Links the bridge prints (agentbox-review open) point at the gate.
    WORKBENCH_PUBLIC_URL: process.env.E2E_PUBLIC_URL ?? `http://127.0.0.1:${gatePort}`,
    WORKBENCH_DATA_PORT: String(dataPort),
    WORKBENCH_DATA_HOST: "127.0.0.1",
    AGENTBOX_GATE_APPS_URL: `http://127.0.0.1:${appsPort}`,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
children.push(bridge);
bridge.on("exit", (code) => {
  if (!stopping) {
    console.error(`bridge exited with ${code}`);
    stop(1);
  }
});

// The gate, in front of the bridge exactly as in the stack: the browser only
// ever talks to it, and signs in first. Its store lives in the throwaway
// directory. The loopback address stands in for the proxy, so a test can play
// another client by sending X-Forwarded-For (see e2e/gate.ts).
// Playwright waits on the gate's sign-in page; the bridge behind it must be
// listening by then, or the first page load is a 502.
await waitForSocket({ host: "127.0.0.1", port }, 20_000);
const gateDir = path.join(root, "gate");
fs.mkdirSync(gateDir, { recursive: true });
const { hashPassword } = await import(path.resolve(appDir, "../gate/dist/password.js"));
// A cheap cost for the seed: every sign-in in the suite verifies against it.
const seed = await hashPassword(process.env.E2E_PASSWORD ?? "e2e-password-1", 4);
// Through the harness entry, which raises only the all-addresses sign-in
// ceiling (see e2e/gate-harness.mjs).
const gate = spawn(process.execPath, [path.join(here, "gate-harness.mjs")], {
  env: {
    ...process.env,
    GATE_HOST: "127.0.0.1",
    GATE_PORT: String(gatePort),
    GATE_DATA_DIR: gateDir,
    GATE_ADMIN_SOCKET: path.join(root, "gate-admin.sock"),
    GATE_UPSTREAM_HOST: "127.0.0.1",
    GATE_BRIDGE_PORT: String(port),
    GATE_DATA_PORT: String(dataPort),
    GATE_APPS_HOST: "127.0.0.1",
    GATE_APPS_PORT: String(appsPort),
    // No code-server here; a spec stands one in on this port when it needs it.
    GATE_CODE_PORT: process.env.E2E_CODE_PORT ?? "7808",
    GATE_TRUSTED_PROXIES: "127.0.0.1",
    AGENTBOX_USER: process.env.E2E_USER ?? "e2e",
    AGENTBOX_PASSWORD_HASH: seed,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
children.push(gate);
gate.on("exit", (code) => {
  if (!stopping) {
    console.error(`gate exited with ${code}`);
    stop(1);
  }
});
