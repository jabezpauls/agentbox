#!/usr/bin/env node
// Boot the real thing for the end-to-end tests: a herdr server on a private
// socket, then the compiled bridge serving the built app against it.
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
const staticDir = path.resolve(appDir, "dist");
const port = Number(process.env.WORKBENCH_PORT ?? 7800);

for (const [what, p] of [["bridge build", bridgeEntry], ["app build", staticDir]]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${what} at ${p} — run \`npm run build\` first`);
    process.exit(1);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-e2e-"));
const home = path.join(root, "home");
const workspaces = path.join(root, "workspaces");
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
    WORKBENCH_BASE_PATH: "/workbench",
    WORKBENCH_STATIC_DIR: staticDir,
    WORKBENCH_WORKSPACE_ROOT: workspaces,
    WORKBENCH_REVIEW_DIR: reviewDir,
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
