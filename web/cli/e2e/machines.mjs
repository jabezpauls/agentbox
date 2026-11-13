#!/usr/bin/env node
// Machines, end to end: the compiled gate with machines on, behind a small
// stand-in for the proxy (it names the box's host and the client's address,
// as Caddy does), and a "machine" — the built CLI bundle in a home folder of
// its own — joining it the way the owner would.
//
//   join (typed code, passphrase on stdin) → online with specs → survives a
//   gate restart → offline on network loss and back → a copied token is
//   refused as a duplicate → pause / resume → revoke stops it, wiping only
//   secrets/.
//
//   npm run build            (in web/)
//   node e2e/machines.mjs    (in web/cli) [--keep]
//
// Needs herdr on PATH, installed by scripts/install-herdr.sh (the node checks
// it against the same pin).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { bundle, cliDir, freePort, waitForPort, which } from "./stack.mjs";

const keep = process.argv.includes("--keep");
const webDir = path.resolve(cliDir, "..");
const gateEntry = path.join(webDir, "gate", "dist", "main.js");
const gateCli = path.join(webDir, "gate", "dist", "cli.js");
for (const f of [gateEntry, bundle]) if (!fs.existsSync(f)) throw new Error(`missing ${f}; run npm run build in web/ first`);
const herdr = which("herdr");
if (!herdr) throw new Error("herdr is not on PATH (scripts/install-herdr.sh)");

const MAIN = "box.example.test";
const MACHINES = "machines.example.test";
const USER = "e2e";
const PASSWORD = "e2e-password-1";
const PASSPHRASE = "machines passphrase for e2e";
// The address the stand-in proxy says the machine came from.
const MACHINE_IP = "203.0.113.7";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-machines-e2e-"));
const gateData = path.join(root, "gate");
fs.mkdirSync(gateData);
const ports = { gate: await freePort(), apps: await freePort(), proxy: await freePort(), unused: await freePort() };
const { hashPassword } = await import(path.join(webDir, "gate", "dist", "password.js"));
const gateEnv = {
  PATH: process.env.PATH,
  GATE_HOST: "127.0.0.1",
  GATE_PORT: String(ports.gate),
  GATE_DATA_DIR: gateData,
  GATE_ADMIN_SOCKET: path.join(root, "gate-admin.sock"),
  GATE_UPSTREAM_HOST: "127.0.0.1",
  GATE_APPS_HOST: "127.0.0.1",
  GATE_APPS_PORT: String(ports.apps),
  ...Object.fromEntries(["CODE", "TERMINAL", "SHELL", "MONITOR", "BRIDGE", "DATA"].map((n) => [`GATE_${n}_PORT`, String(ports.unused)])),
  GATE_TRUSTED_PROXIES: "127.0.0.1",
  AGENTBOX_PUBLIC_URL: `https://${MAIN}`,
  AGENTBOX_MACHINES_HOST: MACHINES,
  AGENTBOX_MACHINE_APPS_HOST: "mapps.example.test",
  AGENTBOX_USER: USER,
  AGENTBOX_PASSWORD_HASH: await hashPassword(PASSWORD, 4),
};

const children = [];
function spawnLogged(name, cmd, args, env, input) {
  const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const out = { text: "" };
  child.stdout.on("data", (c) => (out.text += c));
  child.stderr.on("data", (c) => (out.text += c));
  if (input !== undefined) child.stdin.end(input);
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  const p = { name, child, out, exited };
  children.push(p);
  return p;
}

let gate = null;
async function startGate() {
  gate = spawnLogged("gate", process.execPath, [gateEntry], gateEnv);
  await waitForPort(ports.gate);
}
async function stopGate() {
  gate.child.kill("SIGTERM");
  await gate.exited;
}

// --- the stand-in proxy: the box's host, the client's address, https ---------------
let down = false;
const live = new Set();
const proxyHeaders = (h) => ({ ...h, host: MAIN, "x-forwarded-proto": "https", "x-agentbox-client-ip": MACHINE_IP });
const proxy = http.createServer((req, res) => {
  if (down) return req.socket.destroy();
  const up = http.request({ host: "127.0.0.1", port: ports.gate, method: req.method, path: req.url, headers: proxyHeaders(req.headers) }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.destroy());
  req.pipe(up);
});
proxy.on("connection", (s) => {
  if (down) return s.destroy();
  live.add(s);
  s.on("close", () => live.delete(s));
});
proxy.on("upgrade", (req, socket, head) => {
  if (down) return socket.destroy();
  const up = net.connect(ports.gate, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(proxyHeaders(req.headers))) for (const one of [v].flat()) lines.push(`${k}: ${one}`);
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  live.add(up);
  up.on("close", () => {
    live.delete(up);
    socket.destroy();
  });
  socket.on("close", () => up.destroy());
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
await new Promise((r) => proxy.listen(ports.proxy, "127.0.0.1", r));
const boxUrl = `http://127.0.0.1:${ports.proxy}`;

// --- the owner's browser on the machines origin --------------------------------------
function call(method, p, { host = MACHINES, headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: ports.gate,
        method,
        path: p,
        headers: { host, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
const cookieOf = (res) => String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0];
let machinesCookie = "";
async function signIn() {
  const login = await call("POST", "/_gate/login", { host: MAIN, headers: { origin: `https://${MAIN}` }, body: { username: USER, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`main sign-in: ${login.status} ${login.text}`);
  const handoff = await call("GET", "/_gate/machines/handoff", { host: MAIN, headers: { cookie: cookieOf(login) } });
  const nonce = /n=([A-Za-z0-9_-]+)/.exec(String(handoff.headers.location))?.[1];
  const signin = await call("POST", "/signin", { headers: { origin: `https://${MACHINES}` }, body: { nonce, passphrase: PASSPHRASE } });
  if (signin.status !== 200) throw new Error(`machines sign-in: ${signin.status} ${signin.text}`);
  machinesCookie = cookieOf(signin);
}
const mget = async (p) => (await call("GET", p, { headers: { cookie: machinesCookie } })).json();
const mpost = (p, body = {}) => call("POST", p, { headers: { cookie: machinesCookie, origin: `https://${MACHINES}` }, body });
const machine = async () => (await mget("/_gate/machines/list")).machines[0];

// --- the machine ---------------------------------------------------------------------------
function machineEnv(home) {
  return { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", AGENTBOX_NODE_HERDR_FROM: herdr };
}
const homeA = path.join(root, "laptop");
const homeB = path.join(root, "copied");
for (const h of [homeA, homeB, path.join(homeA, "code")]) fs.mkdirSync(h, { recursive: true });
const nodeDirOf = (home) => path.join(home, ".local", "share", "agentbox", "node");
const cli = (home, args, input) => spawnLogged(`agentbox ${args.join(" ")}`, process.execPath, [bundle, ...args], machineEnv(home), input);

async function until(what, cond, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

let failures = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok    machines: ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  machines: ${name}\n      ${String(err.stack ?? err).split("\n").join("\n      ")}`);
    throw err;
  }
}

let run = null;
try {
  await startGate();
  await step("machines enable: the passphrase reaches the gate on stdin", async () => {
    const set = spawnLogged("gate cli", process.execPath, [gateCli, "machines-passphrase"], gateEnv, `${PASSPHRASE}\n`);
    assert((await set.exited) === 0, set.out.text);
    await signIn();
  });

  await step("join: a typed code, the address the gate saw, a token once", async () => {
    const join = cli(homeA, ["node", "join", boxUrl, "--name", "e2e-laptop", "--folder", path.join(homeA, "code"), "--no-service"], `${PASSPHRASE}\n${PASSPHRASE}\n`);
    const code = await until("the code on the machine's screen", () => /\n {4}([A-Z]{4}-[A-Z]{4})\n/.exec(join.out.text)?.[1]);
    const pending = (await mget("/_gate/machines/joins")).joins;
    assert(pending.length === 1 && pending[0].name === "e2e-laptop" && pending[0].ip === MACHINE_IP, `pending: ${JSON.stringify(pending)}`);
    assert(!JSON.stringify(pending).includes(code), "the pending list carries the code");
    assert((await mpost("/_gate/machines/joins/approve", { code: "BCDF-GHJK" })).status === 404, "a wrong code approved something");
    assert((await mpost("/_gate/machines/joins/approve", { code })).status === 200, "approving failed");
    assert((await join.exited) === 0, join.out.text);
    const dir = nodeDirOf(homeA);
    const creds = JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8"));
    assert(/^abn_/.test(creds.token) && creds.presence.iterations === 600000, "credentials");
    assert((fs.statSync(path.join(dir, "credentials.json")).mode & 0o777) === 0o600, "credentials are not 0600");
    assert((fs.statSync(dir).mode & 0o777) === 0o700, "the node folder is not 0700");
    assert(JSON.parse(fs.readFileSync(path.join(dir, "policy.json"), "utf8")).files[0].path === path.join(homeA, "code"), "policy");
    assert(fs.existsSync(path.join(dir, "bin", "herdr")), "herdr was not installed");
    assert(!join.out.text.includes(creds.token), "the token was printed");
  });

  await step("run: online, with its specs", async () => {
    run = cli(homeA, ["node", "run"]);
    const m = await until("online", async () => ((await machine())?.state === "online" ? machine() : null));
    assert(m.specs.hostname === os.hostname() && m.specs.cpu.cores > 0 && m.specs.policy.files.length === 1, JSON.stringify(m.specs));
    const status = cli(homeA, ["node", "status", "--json"]);
    await status.exited;
    assert(JSON.parse(status.out.text).state === "online", status.out.text);
  });

  await step("survives a gate restart", async () => {
    await stopGate();
    await startGate();
    // The machines session is in the store, and outlives the restart too.
    await until("online again", async () => (await machine())?.state === "online", 60_000);
  });

  await step("offline on network loss, and back", async () => {
    down = true;
    for (const s of live) s.destroy();
    await until("offline", async () => (await machine())?.state === "offline");
    down = false;
    await until("online again", async () => (await machine())?.state === "online", 90_000);
  });

  await step("a copied token is refused as a duplicate while the first answers", async () => {
    const dirB = nodeDirOf(homeB);
    fs.mkdirSync(dirB, { recursive: true, mode: 0o700 });
    for (const f of ["credentials.json", "policy.json"]) fs.copyFileSync(path.join(nodeDirOf(homeA), f), path.join(dirB, f));
    const copy = cli(homeB, ["node", "run"]);
    await until("the duplicate refused", async () => (await machine())?.duplicateAt !== null);
    await until("the copy told", () => copy.out.text.includes("already linked from elsewhere"));
    assert((await machine()).state === "online", "the first link went down");
    copy.child.kill("SIGTERM");
    await copy.exited;
    const audit = await mget("/_gate/machines/audit");
    assert(audit.events.some((e) => e.kind === "duplicate"), "no duplicate in the audit log");
  });

  await step("pause → paused on the machine; resume → online", async () => {
    const pause = cli(homeA, ["node", "pause"]);
    assert((await pause.exited) === 0, pause.out.text);
    await until("paused", async () => (await machine())?.state === "paused");
    assert(JSON.parse(fs.readFileSync(path.join(nodeDirOf(homeA), "policy.json"), "utf8")).paused === true, "policy.json not paused");
    const resume = cli(homeA, ["node", "resume"]);
    assert((await resume.exited) === 0, resume.out.text);
    await until("online", async () => (await machine())?.state === "online");
  });

  await step("revoke: the node stops, wiping secrets/ and nothing else", async () => {
    const dir = nodeDirOf(homeA);
    fs.mkdirSync(path.join(dir, "secrets"), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "secrets", "claude-token"), "not a real token", { mode: 0o600 });
    const id = (await machine()).id;
    assert((await mpost(`/_gate/machines/m/${id}/revoke`)).status === 200, "revoke failed");
    const code = await Promise.race([run.exited, new Promise((r) => setTimeout(() => r("still running"), 20_000))]);
    assert(code === 0, `node run: ${code}\n${run.out.text.slice(-2000)}`);
    assert(!fs.existsSync(path.join(dir, "secrets")), "secrets/ is still there");
    for (const f of ["credentials.json", "policy.json", "bin/herdr"]) assert(fs.existsSync(path.join(dir, f)), `${f} was deleted`);
    assert(typeof JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).revokedAt === "number", "not marked revoked");
    assert((await machine()).state === "revoked", "the box does not show it revoked");
    // Started again (a reboot), it says so and does nothing.
    const again = cli(homeA, ["node", "run"]);
    assert((await again.exited) === 0 && again.out.text.includes("revoked"), again.out.text);
  });
} catch {
  // Reported by step().
} finally {
  for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
  proxy.close();
  if (failures > 0) {
    for (const c of children) console.log(`--- ${c.name}\n${c.out.text.slice(-3000)}`);
  }
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`state kept in ${root}`);
}
console.log(failures ? `\n${failures} failed` : "\nall machines steps passed");
process.exit(failures ? 1 : 0);
