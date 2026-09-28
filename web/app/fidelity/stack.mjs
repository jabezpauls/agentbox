#!/usr/bin/env node
// The fidelity suite's stack: the end-to-end stack (e2e/start-stack.mjs — a
// real herdr, the compiled bridge with its data plane, the compiled gate),
// behind TLS on https://localhost, as the box is behind its proxy. Real
// browsers then treat the gate's Secure and SameSite=None cookies exactly as
// they do on a deployed box, in every engine.
//
// The certificate is made fresh for each run (openssl), and the browsers are
// told to accept it. Ports and the workspace root come from the environment
// the Playwright config sets (see playwright.fidelity.config.ts).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tlsPort = Number(process.env.FIDELITY_PORT);
const gatePort = Number(process.env.GATE_PORT);
const workspaces = process.env.E2E_WORKSPACES;
if (!tlsPort || !gatePort || !workspaces) {
  console.error("FIDELITY_PORT, GATE_PORT and E2E_WORKSPACES must be set (see playwright.fidelity.config.ts)");
  process.exit(1);
}

// A fresh workspace root: the suite copies its projects in.
fs.rmSync(workspaces, { recursive: true, force: true });
fs.mkdirSync(workspaces, { recursive: true });

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "fidelity-cert-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
  "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"),
  "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
], { stdio: "ignore" });

const stack = spawn(process.execPath, [path.join(here, "..", "e2e", "start-stack.mjs")], {
  env: { ...process.env, E2E_PUBLIC_URL: `https://localhost:${tlsPort}` },
  stdio: ["ignore", "inherit", "inherit"],
});

// TLS in front of the gate, bytes through unchanged: plain requests and
// WebSockets alike, as a TLS-terminating proxy passes them.
const server = tls.createServer(
  { key: fs.readFileSync(path.join(certDir, "key.pem")), cert: fs.readFileSync(path.join(certDir, "cert.pem")) },
  (client) => {
    const upstream = net.connect(gatePort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  },
);
server.listen(tlsPort, "127.0.0.1");

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  server.close();
  stack.kill("SIGTERM");
  setTimeout(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
    process.exit(code);
  }, 800).unref?.();
}
stack.on("exit", (code) => {
  if (!stopping) {
    console.error(`the stack exited with ${code}`);
    stop(1);
  }
});
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
