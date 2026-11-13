#!/usr/bin/env node
// A machine on Windows, end to end, against a protocol stub of the gate's
// link (the gate itself does not run on Windows): a small server speaking the
// link's framing from @workbench/hostcore/link, approving the join itself.
//
//   join (the code approved by the stub, the passphrase on stdin) → the
//   sign-in entry added and the supervisor started → online → the control
//   pipe refuses a wrong secret → herdr on its named pipe → presence → a
//   terminal runs a command in PowerShell, with the claude.cmd and
//   agentbox-preview.cmd shims on PATH → Files across volumes (the node's
//   folder on C:, the folder it serves on D:), /C:/-style paths, and the
//   refusals (\\?\, a stream, UNC, a trailing dot, a junction to a share, a
//   PowerShell profile, the credential store) → leave removes the entry.
//
//   npm run build -w hostcore && npm run build:sea -w cli -- --targets win-x64   (in web/)
//   node e2e/windows.mjs                                                         (in web/cli)
//
// On Linux it runs the same flow against dist/agentbox.mjs in a home folder
// of its own, without the service and the Windows-only checks: a way to work
// on it without a Windows machine.
import { spawn, spawnSync } from "node:child_process";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { decodeControl, decodeFrame, encodeControl, encodeFrame, encodeOpen, FrameType, LINK_PATH, StreamTable } from "@workbench/hostcore/link";

const WIN = process.platform === "win32";
const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(cliDir, "dist", "sea", "agentbox.exe");
const bundle = path.join(cliDir, "dist", "agentbox.mjs");
if (WIN && !fs.existsSync(exe)) throw new Error(`missing ${exe}; npm run build:sea -w cli -- --targets win-x64`);
if (!WIN && !fs.existsSync(bundle)) throw new Error(`missing ${bundle}; npm run build -w cli`);

// Generated per run: never a real passphrase or token.
const PASSPHRASE = `windows-e2e-${randomBytes(6).toString("hex")}`;
const TOKEN = `abn_${randomBytes(32).toString("base64url")}`;
const MACHINE_ID = `m${randomBytes(11).toString("hex")}`;
const SESSION = `s${randomBytes(11).toString("hex")}`;

// Windows: the real profile (CI's machine is thrown away), so the node's
// folder is on C: and the folder it serves on D: (RUNNER_TEMP). Linux: a
// home folder of its own.
const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "agentbox-win-e2e-"));
const home = WIN ? os.homedir() : path.join(base, "home");
const code = path.join(base, "code");
fs.mkdirSync(code, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const env = WIN ? { ...process.env } : { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", XDG_CONFIG_HOME: path.join(home, ".config") };
const nodeDir = WIN ? path.join(process.env.LOCALAPPDATA, "agentbox", "node") : path.join(home, ".local", "share", "agentbox", "node");

/** A Windows path as the files API spells it (src/node/files.ts, toApiPath). */
const api = (p) => {
  if (!WIN) return p;
  const m = /^([A-Za-z]):(?:\\(.*))?$/.exec(p);
  const rest = (m?.[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return rest ? `/${m[1]}:/${rest}` : `/${m[1]}:`;
};

const children = [];
function cli(args, input) {
  const [cmd, argv] = WIN ? [exe, args] : [process.execPath, [bundle, ...args]];
  const child = spawn(cmd, argv, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const out = { text: "" };
  child.stdout.on("data", (c) => (out.text += c));
  child.stderr.on("data", (c) => (out.text += c));
  child.stdin.end(input ?? "");
  const exited = new Promise((r) => child.on("exit", (c) => r(c)));
  const p = { args, child, out, exited };
  children.push(p);
  return p;
}

async function until(what, cond, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok    windows: ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    console.log(`FAIL  windows: ${name}\n      ${String(err.stack ?? err).split("\n").join("\n      ")}`);
    throw err;
  }
}
const reg = (...args) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// --- the stub gate ---------------------------------------------------------------------
const joins = [];
const controls = [];
let link = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, o) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method === "POST" && req.url === "/_gate/node/join/start") {
      const b = JSON.parse(body || "{}");
      joins.push({ ...b, polls: 0 });
      return send(200, { joinCode: "jc_e2e", userCode: "BCDF-GHJK", expiresIn: 600, interval: 1, name: b.name, approveAt: null });
    }
    if (req.method === "POST" && req.url === "/_gate/node/join/poll") {
      // The owner "types the code" at the second poll.
      const j = joins.at(-1);
      j.polls += 1;
      return send(200, j.polls < 2 ? { status: "pending" } : { status: "approved", token: TOKEN, machineId: MACHINE_ID, name: j.name });
    }
    send(404, { error: "not found" });
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== LINK_PATH || req.headers.authorization !== `Bearer ${TOKEN}`) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const l = { ws, hello: null, next: 0, table: new StreamTable((f) => ws.readyState === ws.OPEN && ws.send(f)) };
    ws.on("message", (data, binary) => {
      if (!binary) return;
      const frame = decodeFrame(data);
      if (frame.type === FrameType.control) {
        const m = decodeControl(frame.payload);
        if (m.type === "hello") {
          l.hello = m;
          link = l;
          ws.send(encodeControl({ type: "ok", machineId: MACHINE_ID, name: joins.at(-1)?.name ?? "machine" }));
        } else {
          controls.push(m);
          if (m.type === "leave") ws.close(4005, "left");
        }
        return;
      }
      l.table.receive(frame);
    });
    ws.on("close", () => {
      l.table.endAll("closed");
      if (link === l) link = null;
    });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const box = `http://127.0.0.1:${server.address().port}`;

/** A stream to the node, as the gate opens one for a machines session. */
function dial(open) {
  if (!link) throw new Error("the node is not linked");
  link.next += 1;
  link.ws.send(encodeFrame(FrameType.open, link.next, encodeOpen(open)));
  return link.table.open(link.next);
}
let grant = null;
function ask(method, p, body, raw) {
  const payload = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        path: p,
        headers: { connection: "close", ...(payload ? { "content-type": raw ? "application/octet-stream" : "application/json", "content-length": payload.length } : {}) },
        createConnection: (_o, cb) => {
          cb(null, dial({ kind: "http", session: SESSION, grant }));
          return undefined;
        },
      },
      (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(t);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, text: t, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
const q = (p) => encodeURIComponent(p);

let failed = false;
try {
  await step("join: the stub approves, and the node is registered to start at sign-in", async () => {
    const args = ["node", "join", box, "--name", "win-e2e", "--folder", code, "--no-claude", ...(WIN ? [] : ["--no-service"])];
    const join = cli(args, `${PASSPHRASE}\n${PASSPHRASE}\n`);
    const exit = await join.exited;
    assert(exit === 0, `join exited ${exit}:\n${join.out.text}`);
    assert(join.out.text.includes("BCDF-GHJK"), "no code shown");
    assert(!join.out.text.includes(TOKEN), "the token was printed");
    assert(joins[0]?.platform === process.platform, `join said ${JSON.stringify(joins[0])}`);
    if (WIN) {
      assert(/other people also sign in/.test(join.out.text) && /Smart App Control/.test(join.out.text), `no Windows notes:\n${join.out.text}`);
      assert(join.out.text.includes("Online."), `not online:\n${join.out.text}`);
      const r = reg("query", RUN_KEY, "/v", "agentbox-node");
      assert(r.status === 0 && /agentbox-node\.exe" node supervise/.test(r.stdout), `the Run entry: ${r.stdout}${r.stderr}`);
      for (const f of ["herdr.exe", "conpty\\conpty.dll", "conpty\\x64\\OpenConsole.exe"]) assert(fs.existsSync(path.join(nodeDir, "bin", "herdr", f)), `bin\\herdr\\${f} missing`);
    } else {
      cli(["node", "run"]);
    }
    await until("the link", () => link?.hello);
    assert(link.hello.platform === process.platform && link.hello.policy.files.length === 1, JSON.stringify(link.hello));
    assert(link.hello.policy.files[0].path === api(code), `the policy's folder is reported as ${link.hello.policy.files[0].path}`);
  });

  let status = null;
  await step("status over the control pipe; a wrong secret is refused", async () => {
    status = await until("online", async () => {
      const s = cli(["node", "status", "--json"]);
      await s.exited;
      try {
        const o = JSON.parse(s.out.text);
        return o.state === "online" && o.herdrSocket ? o : null;
      } catch {
        return null;
      }
    }, 60_000);
    if (WIN) {
      assert(status.service === true, `service: ${JSON.stringify(status)}`);
      const pipe = fs.readFileSync(path.join(nodeDir, "control.pipe"), "utf8").trim();
      assert(/^\\\\\.\\pipe\\agentbox-node-[0-9a-f]{32}$/.test(pipe), `control.pipe says ${pipe}`);
      const answer = await new Promise((resolve, reject) => {
        const s = net.connect(pipe);
        let t = "";
        s.on("connect", () => s.write(`${JSON.stringify({ secret: "not-the-secret", command: "status" })}\n`));
        s.on("data", (c) => (t += c));
        s.on("end", () => resolve(t));
        s.on("error", reject);
      });
      assert(JSON.parse(answer).error === "refused", `a wrong secret: ${answer}`);
    }
  });

  await step("herdr answers on its named pipe, in a session of its own", async () => {
    const socket = status.herdrSocket;
    const at = WIN ? `\\\\.\\pipe\\${socket}` : socket;
    const pong = await new Promise((resolve, reject) => {
      const s = net.connect(at);
      let t = "";
      s.on("connect", () => s.write(`${JSON.stringify({ id: "1", method: "ping", params: {} })}\n`));
      s.on("data", (c) => {
        t += c;
        if (t.includes("\n")) {
          s.destroy();
          resolve(JSON.parse(t.split("\n")[0]));
        }
      });
      s.on("error", reject);
    });
    assert(pong.result?.version === "0.9.3", `ping: ${JSON.stringify(pong)}`);
    if (WIN) {
      // The path itself is herdr's marker file, not a socket.
      assert(fs.existsSync(socket) && path.dirname(socket) === nodeDir, `the marker file ${socket}`);
      const plain = await new Promise((resolve) => {
        const s = net.connect(socket);
        s.on("connect", () => resolve("connected"));
        s.on("error", (e) => resolve(e.code));
      });
      assert(plain !== "connected", "the plain path connected");
    }
  });

  await step("presence: nothing of herdr's without it", async () => {
    const before = await ask("POST", "/api/rpc", { method: "ping" });
    assert(before.status === 401, `before presence: ${before.status} ${before.text}`);
    const c = await ask("POST", "/presence/challenge", {});
    assert(c.status === 200, `challenge: ${c.status} ${c.text}`);
    const key = pbkdf2Sync(PASSPHRASE, Buffer.from(c.json.salt, "base64url"), c.json.iterations, 32, "sha256");
    const answer = createHmac("sha256", key)
      .update(Buffer.concat([Buffer.from(c.json.challenge, "base64url"), Buffer.from(SESSION + MACHINE_ID)]))
      .digest("base64url");
    const r = await ask("POST", "/presence/answer", { challenge: c.json.challenge, answer });
    assert(r.status === 200, `answer: ${r.status} ${r.text}`);
    grant = r.json.grant;
  });

  await step("a terminal runs a command, with the node's shims on PATH", async () => {
    const created = await until("herdr up", async () => {
      const r = await ask("POST", "/api/rpc", { method: "workspace.create", params: { cwd: code } });
      return r.status === 200 ? r.json : null;
    });
    const pane = created.result.root_pane.pane_id;
    const t = { text: "" };
    const ws = new WebSocket(`ws://machine/ws/terminal?pane=${q(pane)}&cols=120&rows=30`, { createConnection: () => dial({ kind: "upgrade", session: SESSION, grant }) });
    ws.on("message", (data, binary) => {
      if (binary) t.text += data.toString("utf8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]|\x1b\][^\x07]*\x07/g, "");
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("unexpected-response", (_q, res) => reject(new Error(`terminal refused: ${res.statusCode}`)));
      ws.once("error", reject);
    });
    const type = (text) => ws.send(JSON.stringify({ type: "input", text }));
    const seen = (s) => t.text.replace(/\s+/g, "").includes(s);
    const on = (what, s) => until(what, () => seen(s), 30_000).catch((err) => {
      throw new Error(`${err.message}; the screen said: ${t.text.slice(-800)}`);
    });
    await new Promise((r) => setTimeout(r, 1_000));
    type(WIN ? 'echo "ok-$(40+2)"\r' : "echo ok-$((40+2))\r");
    await on("ok-42", "ok-42");
    if (WIN) {
      type('echo "shell-$($PSVersionTable.PSEdition)"\r');
      await on("the shell", "shell-Core");
      // herdr's panes take Windows' PATH from the registry: the shell shim puts the node's folders back.
      type('echo "shim-$((Get-Command claude).Source) parent-$((Get-CimInstance Win32_Process -Filter "ProcessId=$((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)").Name)"\r');
      await on("claude.cmd", "claude.cmd");
      await on("the shell shim as the shell's parent", "parent-cmd.exe");
    } else {
      type('echo "shim-$(command -v claude)"\r');
      await on("the claude shim", "shims/claude");
    }
    type("agentbox-preview list\r");
    await on("agentbox-preview, over the control pipe", "Noappsregisteredonthismachine.");
    ws.close();
  });

  const file = path.join(code, "hello.txt");
  await step("files: write, overwrite, upload, trash and restore, across volumes, /C:/-style", async () => {
    const w = await ask("POST", "/api/files/write", { path: api(file), content: "one\n" });
    assert(w.status === 200 && w.json.path === api(file), `write: ${w.status} ${w.text}`);
    const o = await ask("POST", "/api/files/write", { path: api(file), content: "two\n", overwrite: true });
    assert(o.status === 200 && fs.readFileSync(file, "utf8") === "two\n", `overwrite: ${o.status} ${o.text}`);
    const up = await ask("POST", "/api/files/uploads", { path: api(path.join(code, "up.bin")), size: 5 });
    assert(up.status === 200, `upload: ${up.status} ${up.text}`);
    const put = await ask("PUT", `/api/files/uploads/${up.json.uploadId}?offset=0`, undefined, Buffer.from("hello"));
    assert(put.status === 200, `put: ${put.status} ${put.text}`);
    const fin = await ask("POST", `/api/files/uploads/${up.json.uploadId}/finish`, {});
    assert(fin.status === 200 && fs.readFileSync(path.join(code, "up.bin"), "utf8") === "hello", `finish: ${fin.status} ${fin.text}`);
    const tr = await ask("POST", "/api/files/trash", { paths: [api(file)] });
    assert(tr.status === 200 && tr.json.trashed[0].originalPath === api(file) && !fs.existsSync(file), `trash: ${tr.status} ${tr.text}`);
    const re = await ask("POST", `/api/files/trash/${tr.json.trashed[0].id}/restore`, {});
    assert(re.status === 200 && fs.readFileSync(file, "utf8") === "two\n", `restore: ${re.status} ${re.text}`);
    const list = await ask("GET", `/api/files/list?path=${q(api(code))}`);
    assert(list.status === 200 && list.json.path === api(code), `list: ${list.status} ${list.text}`);
    const names = list.json.entries.map((e) => e.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(["hello.txt", "up.bin"]), `the folder holds ${names.join(" ")} (scratch left behind?)`);
    assert(list.json.entries.every((e) => e.path === `${api(code)}/${e.name}`), JSON.stringify(list.json.entries));
  });

  await step("files: the refusals", async () => {
    const policyFile = path.join(nodeDir, "policy.json");
    const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    fs.writeFileSync(policyFile, JSON.stringify({ ...policy, files: [{ path: code, mode: "write" }, { path: "~", mode: "write" }] }));
    await until("the home folder allowed", async () => (await ask("GET", `/api/files/list?path=${q(api(home))}`)).status === 200, 15_000);
    const refused = async (what, p, want) => {
      const r = await ask("GET", `/api/files/stat?path=${q(p)}`);
      assert(want.includes(r.status), `${what} (${p}): ${r.status} ${r.text}`);
    };
    if (WIN) {
      const drive = code.slice(0, 1);
      await refused("a \\\\?\\ path", `//?/${drive}:/${api(code).slice(4)}/hello.txt`, [400]);
      await refused("a device path", "//./pipe/x", [400]);
      await refused("an alternate data stream", `${api(file)}:secret`, [400]);
      await refused("a UNC path", "//localhost/C$/Windows", [400]);
      await refused("a trailing dot", `${api(file)}.`, [400]);
      await refused("the credential store", api(path.join(process.env.APPDATA, "Microsoft", "Credentials")), [404]);
      // A link to a network share, inside an allowed folder: never followed.
      const link = path.join(code, "share-link");
      let linked = false;
      try {
        fs.symlinkSync("\\\\localhost\\C$\\Windows", link, "dir");
        linked = true;
      } catch (err) {
        console.log(`      (no link to a share: ${err.code}; that refusal is not exercised)`);
      }
      if (linked) {
        const r = await ask("GET", `/api/files/list?path=${q(api(link))}`);
        assert(r.status === 403 || r.status === 404, `through a link to a share: ${r.status} ${r.text.slice(0, 200)}`);
        fs.rmSync(link, { force: true, recursive: false });
      }
      const profile = path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
      const w = await ask("POST", "/api/files/write", { path: api(profile), content: "Write-Host owned\n" });
      assert(w.status === 403 && !fs.existsSync(profile), `a PowerShell profile: ${w.status} ${w.text}`);
      const startup = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "x.cmd");
      const s = await ask("POST", "/api/files/write", { path: api(startup), content: "calc\n" });
      assert(s.status === 403, `the Startup folder: ${s.status} ${s.text}`);
    } else {
      const w = await ask("POST", "/api/files/write", { path: path.join(home, ".bashrc"), content: "x\n" });
      assert(w.status === 403, `~/.bashrc: ${w.status} ${w.text}`);
    }
    const n = await ask("POST", "/api/files/write", { path: api(policyFile), content: "{}", overwrite: true });
    assert(n.status === 403, `the node's folder: ${n.status} ${n.text}`);
  });

  await step("leave: the box is told, and the sign-in entry is removed", async () => {
    const herdrPid = JSON.parse(fs.readFileSync(path.join(nodeDir, "state", "herdr.json"), "utf8")).pid;
    const leave = cli(["node", "leave"]);
    const exit = await leave.exited;
    assert(exit === 0 && /^Left http/m.test(leave.out.text), `leave exited ${exit}:\n${leave.out.text}`);
    assert(controls.some((m) => m.type === "leave"), "the stub was not told");
    assert(!fs.existsSync(path.join(nodeDir, "credentials.json")), "credentials.json is still there");
    if (WIN) {
      assert(reg("query", RUN_KEY, "/v", "agentbox-node").status !== 0, "the Run entry is still there");
      await until("the supervisor gone", () => !fs.existsSync(path.join(nodeDir, "state", "supervise.json")), 15_000);
      const log = fs.readFileSync(path.join(nodeDir, "state", "node.log"), "utf8");
      assert(/supervise: starting/.test(log) && /link: online/.test(log), `node.log:\n${log.slice(-1500)}`);
      assert(!log.includes(TOKEN) && !log.includes(PASSPHRASE), "a secret is in the log");
    }
    try {
      process.kill(herdrPid);
    } catch {
      // gone
    }
  });
} catch {
  failed = true;
  for (const c of children) if (c.out.text.trim()) console.log(`--- agentbox ${c.args.join(" ")}\n${c.out.text.slice(-3000)}`);
  const log = path.join(nodeDir, "state", "node.log");
  if (fs.existsSync(log)) console.log(`--- ${log}\n${fs.readFileSync(log, "utf8").slice(-6000)}`);
  if (WIN) reg("delete", RUN_KEY, "/v", "agentbox-node", "/f");
} finally {
  for (const c of children) if (c.child.exitCode === null) c.child.kill();
  server.close();
  wss.close();
  if (!WIN) fs.rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
