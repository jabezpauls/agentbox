import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";

/**
 * A machine's app, on the machine-apps origin, in a real browser: it runs in
 * an opaque origin and can read nothing on the machines origin, though the
 * browser holds a machines session (its sandbox, not the missing cookie, is
 * what stops it: the request goes, and its answer is unreadable).
 *
 * Its own small stack beside the suite's: the compiled gate with machines on
 * (box.localhost, machines.localhost, mapps.localhost behind TLS), and an
 * in-process machine speaking the link with the gate's own codec, whose app
 * stream answers with the app. Chromium only: it resolves `*.localhost` to
 * the loopback by itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..", "..");
const gateDist = path.join(webDir, "gate", "dist");
const PASSPHRASE = `fidelity passphrase ${process.pid}`;
const USER = "e2e";
const PASSWORD = "e2e-password-1";

type Link = typeof import("../../gate/dist/link/index.js");

let gate: ChildProcess | null = null;
let front: tls.Server | null = null;
let link: WebSocket | null = null;
let root = "";
let tlsPort = 0;
let gatePort = 0;

const host = (name: string) => `${name}.localhost`;
const origin = (name: string) => `https://${host(name)}:${tlsPort}`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** The test's own requests, to the gate's listener (a trusted proxy's address), as the proxy would send them. */
function call(method: string, p: string, name: string, headers: Record<string, string> = {}, body?: object) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gatePort,
        method,
        path: p,
        headers: { host: host(name), "x-forwarded-proto": "https", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
const cookieOf = (r: { headers: http.IncomingHttpHeaders }) => String(r.headers["set-cookie"]?.[0] ?? "").split(";")[0] as string;

/** What the machine's app serves: a page that tries to read the machines origin, and says what it could. */
function appPage(machines: string): string {
  return `<!doctype html><title>machine app</title><p id="result">running</p><script>
(async () => {
  let machines;
  try {
    const r = await fetch(${JSON.stringify(`${machines}/_gate/machines/list`)}, { credentials: "include" });
    machines = "READ " + r.status + " " + (await r.text()).slice(0, 40);
  } catch (e) {
    machines = "refused";
  }
  document.getElementById("result").textContent = "origin=" + self.origin + " machines=" + machines;
})();
</script>`;
}

test.beforeAll(async ({ browserName }) => {
  if (browserName !== "chromium") return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fidelity-machines-"));
  tlsPort = await freePort();
  gatePort = await freePort();
  const unused = await freePort();
  const { hashPassword } = (await import(path.join(gateDist, "password.js"))) as { hashPassword: (p: string, cost: number) => Promise<string> };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GATE_HOST: "127.0.0.1",
    GATE_PORT: String(gatePort),
    GATE_DATA_DIR: path.join(root, "gate"),
    GATE_ADMIN_SOCKET: path.join(root, "gate-admin.sock"),
    GATE_UPSTREAM_HOST: "127.0.0.1",
    GATE_APPS_HOST: "127.0.0.1",
    GATE_APPS_PORT: String(await freePort()),
    ...Object.fromEntries(["CODE", "TERMINAL", "SHELL", "MONITOR", "BRIDGE", "DATA"].map((n) => [`GATE_${n}_PORT`, String(unused)])),
    GATE_TRUSTED_PROXIES: "127.0.0.1",
    AGENTBOX_PUBLIC_URL: `https://${host("box")}`,
    AGENTBOX_MACHINES_HOST: host("machines"),
    AGENTBOX_MACHINE_APPS_HOST: host("mapps"),
    AGENTBOX_USER: USER,
    AGENTBOX_PASSWORD_HASH: await hashPassword(PASSWORD, 4),
  };
  fs.mkdirSync(env.GATE_DATA_DIR as string);
  gate = spawn(process.execPath, [path.join(gateDist, "main.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((r) => net.connect(gatePort, "127.0.0.1").once("connect", function (this: net.Socket) {
      this.destroy();
      r(true);
    }).once("error", () => r(false)));
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // The passphrase, on stdin, to the running gate (as `machines enable` does).
  const set = spawn(process.execPath, [path.join(gateDist, "cli.js"), "machines-passphrase"], { env, stdio: ["pipe", "ignore", "inherit"] });
  set.stdin.end(`${PASSPHRASE}\n`);
  expect(await new Promise((r) => set.on("exit", r))).toBe(0);

  // TLS in front, bytes through unchanged, as a TLS-terminating proxy passes them.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"), "-subj", "/CN=box.localhost"], { stdio: "ignore" });
  front = tls.createServer({ key: fs.readFileSync(path.join(root, "key.pem")), cert: fs.readFileSync(path.join(root, "cert.pem")) }, (client) => {
    const upstream = net.connect(gatePort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      s.on("error", end);
      s.on("close", end);
    }
  });
  await new Promise<void>((r) => (front as tls.Server).listen(tlsPort, "127.0.0.1", r));
});

test.afterAll(async () => {
  link?.terminate();
  front?.close();
  if (gate && gate.exitCode === null) {
    const exited = new Promise((r) => gate?.once("exit", r));
    gate.kill("SIGTERM");
    await exited;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("a machine's app runs in an opaque origin and cannot read the machines origin", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "*.localhost resolves to the loopback by itself in Chromium");
  const { decodeControl, decodeFrame, decodeOpen, encodeControl, FrameType, STREAM_WINDOW, StreamTable } = (await import(path.join(gateDist, "link", "index.js"))) as Link;

  // The owner: signed in to the box, then to machines with the passphrase.
  const login = await call("POST", "/_gate/login", "box", { origin: `https://${host("box")}` }, { username: USER, password: PASSWORD });
  expect(login.status).toBe(200);
  const handoff = await call("GET", "/_gate/machines/handoff", "box", { cookie: cookieOf(login) });
  const nonce = /n=([A-Za-z0-9_-]+)/.exec(String(handoff.headers.location))?.[1] as string;
  const signin = await call("POST", "/signin", "machines", { origin: `https://${host("machines")}` }, { nonce, passphrase: PASSPHRASE });
  expect(signin.status, signin.text).toBe(200);
  const machinesCookie = cookieOf(signin);
  const mPost = (p: string, body: object = {}) => call("POST", p, "machines", { cookie: machinesCookie, origin: `https://${host("machines")}` }, body);

  // A machine joins, with a typed code.
  const start = JSON.parse((await call("POST", "/_gate/node/join/start", "box", {}, { name: "fidelity", platform: "linux", arch: "x64", hostname: "fid" })).text) as { joinCode: string; userCode: string };
  expect((await mPost("/_gate/machines/joins/approve", { code: start.userCode })).status).toBe(200);
  const { token, machineId } = JSON.parse((await call("POST", "/_gate/node/join/poll", "box", {}, { joinCode: start.joinCode })).text) as { token: string; machineId: string };

  // Its link: every app stream is answered by the app.
  const appServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(appPage(origin("machines")));
  });
  link = new WebSocket(`ws://127.0.0.1:${gatePort}/_gate/node`, { headers: { host: host("box"), authorization: `Bearer ${token}` } });
  const ws = link;
  const table = new StreamTable((f: Buffer) => ws.send(f), STREAM_WINDOW);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () =>
      ws.send(
        encodeControl({
          type: "hello",
          protocol: 1,
          version: "0.1.0",
          nonce: "N".repeat(43),
          platform: "linux",
          arch: "x64",
          hostname: "fid",
          cpu: { model: "cpu", cores: 1 },
          ramBytes: 1,
          disks: [],
          gpus: [],
          docker: false,
          claude: null,
          policy: { terminals: false, files: [], ports: true, share: false, updates: "off", presenceHours: 12, paused: false, problem: null },
        }),
      ),
    );
    ws.on("message", (data: Buffer) => {
      const f = decodeFrame(data);
      if (f.type === FrameType.control) {
        if (decodeControl(f.payload).type === "ok") {
          ws.send(encodeControl({ type: "apps", apps: [{ port: 5173, name: "app" }] }));
          resolve();
        }
        return;
      }
      if (f.type === FrameType.open) {
        const s = table.open(f.stream);
        if (decodeOpen(f.payload).app === 5173) appServer.emit("connection", s);
        else s.destroy();
        return;
      }
      table.receive(f);
    });
    ws.once("error", reject);
  });
  let apps: Array<{ id: string }> = [];
  for (let i = 0; i < 50 && apps.length === 0; i++) {
    apps = (JSON.parse((await call("GET", `/_gate/machines/m/${machineId}/apps`, "machines", { cookie: machinesCookie })).text) as { apps: Array<{ id: string }> }).apps;
    if (apps.length === 0) await new Promise((r) => setTimeout(r, 100));
  }
  const app = apps[0] as { id: string };
  const opened = JSON.parse((await mPost(`/_gate/machines/m/${machineId}/apps/${app.id}/open`)).text) as { url: string };
  const enter = new URL(opened.url);

  // The browser holds the machines session, and opens the app as the Preview does.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name: "__Host-agentbox-machines", value: machinesCookie.split("=")[1] as string, domain: host("machines"), path: "/", secure: true, httpOnly: true, sameSite: "Strict" }]);
  const page = await ctx.newPage();
  await page.goto(`${origin("mapps")}${enter.pathname}${enter.search}`);
  await expect(page).toHaveURL(`${origin("mapps")}/${app.id}/`);
  await expect(page.locator("#result")).toHaveText("origin=null machines=refused");
  await ctx.close();
});
