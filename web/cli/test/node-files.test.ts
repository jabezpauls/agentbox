import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { decodeFrame, StreamTable, type StreamOpen } from "@workbench/hostcore/link";
import { filesFor, pathLists, pathRules, refuseWindowsPath, rootId } from "../src/node/files.js";
import { nodePaths } from "../src/node/paths.js";
import { parsePolicy, type LoadedPolicy } from "../src/node/policy.js";
import { enrol, PresenceGate, presenceAnswer, derive } from "../src/node/presence.js";
import { MAX_APPS, Previews, writePreviewShim } from "../src/node/preview.js";
import { NodeServer } from "../src/node/server.js";
import { tmpDir } from "./helpers.js";

/** A home folder with the things the lists name, and a project in it. */
function home() {
  const h = fs.realpathSync(tmpDir("agentbox-home-"));
  const node = path.join(h, ".local", "share", "agentbox", "node");
  for (const d of ["code/app", ".ssh", ".config/systemd/user", "dotfiles"]) fs.mkdirSync(path.join(h, d), { recursive: true });
  fs.mkdirSync(node, { recursive: true });
  fs.writeFileSync(path.join(h, "code", "app", "a.txt"), "hello\n");
  fs.writeFileSync(path.join(h, ".ssh", "id_ed25519"), "not a real key\n");
  fs.writeFileSync(path.join(h, "dotfiles", "bashrc"), "# bashrc\n");
  fs.symlinkSync(path.join(h, "dotfiles", "bashrc"), path.join(h, ".bashrc"));
  fs.writeFileSync(path.join(node, "credentials.json"), "{}");
  return { home: h, node, paths: nodePaths(node) };
}

function service(h: ReturnType<typeof home>, files: Array<{ path: string; mode: "read" | "write" }>) {
  const rules = pathRules({ home: h.home, nodeDir: h.node });
  const policy = parsePolicy(JSON.stringify({ files }), h.home).policy;
  const svc = filesFor(policy, h.paths, rules);
  if (!svc) throw new Error("no service");
  return svc;
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return (err as { status?: number }).status ?? 500;
  }
}

describe("the never-writable and never-visible lists", () => {
  it("name the spec's paths, on Linux and on Windows", () => {
    const linux = pathLists({ home: "/home/o", nodeDir: "/home/o/.local/share/agentbox/node", platform: "linux", env: {} });
    expect(linux.hidden).toEqual(expect.arrayContaining(["/home/o/.ssh", "/home/o/.gnupg", "/home/o/.config/agentbox", "/home/o/.claude/.credentials.json", "/home/o/.mozilla"]));
    expect(linux.writeDenied).toEqual(
      expect.arrayContaining(["/home/o/.local/share/agentbox/node", "/home/o/.bashrc", "/home/o/.profile", "/home/o/.zshrc", "/home/o/.config/fish", "/home/o/.config/systemd/user", "/home/o/.config/autostart", "/home/o/.ssh/authorized_keys", "/home/o/.gitconfig"]),
    );
    const win = pathLists({ home: "C:\\Users\\o", nodeDir: "C:\\Users\\o\\AppData\\Local\\agentbox\\node", platform: "win32", env: { APPDATA: "C:\\Users\\o\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local" } });
    expect(win.hidden).toEqual(expect.arrayContaining(["C:\\Users\\o\\AppData\\Roaming\\Microsoft\\Credentials", "C:\\Users\\o\\AppData\\Local\\Microsoft\\Credentials", "C:\\Users\\o\\.ssh"]));
    expect(win.writeDenied).toEqual(expect.arrayContaining(["C:\\Users\\o\\Documents\\PowerShell", "C:\\Users\\o\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"]));
  });

  it("compare case-insensitively on Windows and macOS, and exactly on Linux", () => {
    const win = pathRules({ home: "C:\\Users\\o", nodeDir: "C:\\Users\\o\\AppData\\Local\\agentbox\\node", platform: "win32", env: {}, resolve: false });
    expect(win.isHidden("c:\\users\\O\\.SSH\\id_rsa")).toBe(true);
    expect(win.isWriteDenied("C:\\USERS\\o\\appdata\\local\\AGENTBOX\\node\\policy.json")).toBe(true);
    expect(win.isWriteDenied("C:\\Users\\o\\code\\x.txt")).toBe(false);
    const mac = pathRules({ home: "/Users/o", nodeDir: "/Users/o/.local/share/agentbox/node", platform: "darwin", env: {}, resolve: false });
    expect(mac.isWriteDenied("/users/O/.BashRC")).toBe(true);
    const linux = pathRules({ home: "/home/o", nodeDir: "/home/o/n", platform: "linux", env: {}, resolve: false });
    expect(linux.isWriteDenied("/home/o/.bashrc")).toBe(true);
    expect(linux.isWriteDenied("/home/o/.BASHRC")).toBe(false);
    expect(linux.isWriteDenied("/home/o/.bashrc-notes")).toBe(false);
    expect(linux.isHidden("/home/o/.sshkeys")).toBe(false);
  });

  it("never let a repository's git config or hooks be written", () => {
    const r = pathRules({ home: "/home/o", nodeDir: "/home/o/n", platform: "linux", env: {}, resolve: false });
    expect(r.isWriteDenied("/home/o/code/app/.git/config")).toBe(true);
    expect(r.isWriteDenied("/home/o/code/app/.git/hooks/pre-commit")).toBe(true);
    expect(r.isWriteDenied("/home/o/code/app/.git/HEAD")).toBe(false);
    expect(r.isWriteDenied("/home/o/code/app/src/config")).toBe(false);
  });

  it("refuse Windows' other path forms outright: UNC, device paths, streams, trailing dots and spaces, DOS devices", () => {
    for (const bad of ["\\\\server\\share\\x", "//server/share", "\\\\.\\pipe\\x", "\\\\?\\C:\\x", "//?/C:/x", "C:\\code\\a.txt:secret", "/C:/code/a.txt:$DATA", "C:/code/.bashrc.", "C:/code/dir /x", "C:/code/NUL", "C:/code/com1.txt"]) {
      expect(refuseWindowsPath(bad), bad).not.toBeNull();
    }
    for (const ok of ["C:\\code\\a.txt", "/C:/code/a.txt", "C:/code/v1.2/x", "C:/code/..", "relative/name.txt", "C:/code/console.log"]) {
      expect(refuseWindowsPath(ok), ok).toBeNull();
    }
    const win = pathRules({ home: "C:\\Users\\o", nodeDir: "C:\\n", platform: "win32", env: {}, resolve: false });
    expect(win.refusePath("C:/x:y")).not.toBeNull();
    expect(pathRules({ home: "/home/o", nodeDir: "/n", platform: "linux", env: {}, resolve: false }).refusePath("/home/o/a:b ")).toBeNull();
  });
});

describe("files on a machine", () => {
  it("reads and writes in a write folder, and keeps its state in the node's folder", async () => {
    const h = home();
    const svc = service(h, [{ path: "~/code", mode: "write" }]);
    expect((await svc.roots.target(path.join(h.home, "code", "app", "a.txt"))).real).toBe(path.join(h.home, "code", "app", "a.txt"));
    await svc.ops.write({ path: path.join(h.home, "code", "app", "b.txt"), content: "new" });
    expect(fs.readFileSync(path.join(h.home, "code", "app", "b.txt"), "utf8")).toBe("new");
    await svc.trash.trash([path.join(h.home, "code", "app", "b.txt")]);
    expect(fs.existsSync(path.join(h.home, "code", ".agentbox"))).toBe(false);
    expect(fs.readdirSync(path.join(h.node, "state", "files", rootId(path.join(h.home, "code")), "trash"))).toHaveLength(1);
  });

  it("refuses every change under a read folder", async () => {
    const h = home();
    const svc = service(h, [{ path: "~/code", mode: "read" }]);
    expect(await status(svc.ops.write({ path: path.join(h.home, "code", "x.txt"), content: "x" }))).toBe(403);
    expect(await status(svc.trash.trash([path.join(h.home, "code", "app", "a.txt")]))).toBe(403);
    expect(await status(svc.roots.target(path.join(h.home, "code", "app", "a.txt")))).toBe(200);
  });

  it("refuses writes to shell profiles and the node's folder, and hides ~/.ssh, even with the whole home allowed", async () => {
    const h = home();
    const svc = service(h, [{ path: "~", mode: "write" }]);
    // ~/.bashrc is a link into dotfiles/: refused as itself and where it leads.
    expect(await status(svc.ops.write({ path: path.join(h.home, ".bashrc"), content: "evil", overwrite: true }))).toBe(403);
    expect(await status(svc.ops.write({ path: path.join(h.home, "dotfiles", "bashrc"), content: "evil", overwrite: true }))).toBe(403);
    expect(fs.readFileSync(path.join(h.home, "dotfiles", "bashrc"), "utf8")).toBe("# bashrc\n");
    expect(await status(svc.ops.write({ path: path.join(h.home, ".config", "systemd", "user", "x.service"), content: "x" }))).toBe(403);
    expect(await status(svc.ops.write({ path: path.join(h.node, "policy.json"), content: "{}" }))).toBe(403);
    expect(await status(svc.ops.mkdir({ path: path.join(h.home, ".config", "autostart") }))).toBe(403);
    expect(await status(svc.trash.trash([path.join(h.home, ".bashrc")]))).toBe(403);
    // Readable: a profile is no secret.
    expect(await status(svc.roots.target(path.join(h.home, ".bashrc")))).toBe(200);
    // ~/.ssh reads as missing, listed or not; and so do the node's secrets.
    expect(await status(svc.roots.target(path.join(h.home, ".ssh", "id_ed25519")))).toBe(404);
    expect(await status(svc.roots.entry(path.join(h.home, ".ssh")))).toBe(404);
    expect(await status(svc.roots.target(path.join(h.node, "credentials.json")))).toBe(404);
    expect(await status(svc.ops.write({ path: path.join(h.home, ".ssh", "authorized_keys"), content: "ssh-ed25519 x" }))).toBe(404);
  });

  it("refuses a link that leads out of its folder, whichever way it is used", async () => {
    const h = home();
    fs.symlinkSync(path.join(h.home, ".ssh"), path.join(h.home, "code", "keys"));
    fs.symlinkSync(path.join(h.home, ".bashrc"), path.join(h.home, "code", "rc"));
    const svc = service(h, [{ path: "~/code", mode: "write" }]);
    expect(await status(svc.roots.target(path.join(h.home, "code", "keys", "id_ed25519")))).toBe(403);
    expect(await status(svc.roots.target(path.join(h.home, "code", "rc")))).toBe(403);
    expect(await status(svc.ops.write({ path: path.join(h.home, "code", "keys", "x"), content: "x" }))).toBe(403);
    expect(await status(svc.roots.target(path.join(h.home, "code", "..", ".ssh")))).toBe(403);
    // Overwriting the link replaces the link, never what it points at.
    await svc.ops.write({ path: path.join(h.home, "code", "rc"), content: "mine", overwrite: true });
    expect(fs.readFileSync(path.join(h.home, "dotfiles", "bashrc"), "utf8")).toBe("# bashrc\n");
  });

  it("empties what has been in the trash for 7 days", async () => {
    const h = home();
    const svc = service(h, [{ path: "~/code", mode: "write" }]);
    const { trashed } = await svc.trash.trash([path.join(h.home, "code", "app", "a.txt")]);
    expect(await svc.trash.expire(Date.now() - 7 * 86_400_000)).toBe(0);
    expect(await svc.trash.list()).toHaveLength(1);
    expect(await svc.trash.expire(Date.now() + 1_000)).toBe(1);
    expect(await svc.trash.list()).toHaveLength(0);
    expect(trashed).toHaveLength(1);
  });

  it("allows no folder when the policy names none", () => {
    const h = home();
    expect(filesFor(parsePolicy("{}", h.home).policy, h.paths, pathRules({ home: h.home, nodeDir: h.node }))).toBeNull();
  });
});

// --- the node's server: files and apps over streams -----------------------------------

const SESSION = "a".repeat(24);
const MACHINE = "b".repeat(24);
const PASS = `test-pass-${randomBytes(6).toString("hex")}`;

function harness(h: ReturnType<typeof home>, policyText: string, presence: PresenceGate, previews = new Previews()) {
  let policy: LoadedPolicy = parsePolicy(policyText, h.home);
  const rules = pathRules({ home: h.home, nodeDir: h.node });
  let files = filesFor(policy.policy, h.paths, rules);
  const server = new NodeServer({ herdrSocket: () => null, hub: () => null, streams: () => null, policy: () => policy, presence, home: h.home, files: () => files, previews });
  const ends: { gate?: StreamTable; node?: StreamTable } = {};
  ends.gate = new StreamTable((f) => setImmediate(() => ends.node?.receive(decodeFrame(f))));
  ends.node = new StreamTable((f) => setImmediate(() => ends.gate?.receive(decodeFrame(f))));
  let id = 0;
  const dial = (open: StreamOpen) => {
    id += 1;
    const near = ends.gate?.open(id);
    server.accept(ends.node?.open(id) as never, open);
    return near as unknown as import("node:stream").Duplex;
  };
  const ask = (method: string, p: string, open: StreamOpen, body?: string | object, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = http.request(
        {
          method,
          path: p,
          headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
          createConnection: (_o, cb) => {
            cb(null, dial(open) as never);
            return undefined;
          },
        },
        (res) => {
          let t = "";
          res.on("data", (c: Buffer) => (t += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  return {
    server,
    ask,
    dial,
    previews,
    setPolicy: (text: string) => {
      policy = parsePolicy(text, h.home);
      files = filesFor(policy.policy, h.paths, rules);
    },
  };
}

async function grantFor(g: PresenceGate, presence: { salt: string; iterations: number }): Promise<string> {
  const c = g.challenge(SESSION) as { challenge: string };
  const key = await derive(PASS, Buffer.from(presence.salt, "base64url"), presence.iterations);
  const r = g.answer(SESSION, c.challenge, presenceAnswer(key, Buffer.from(c.challenge, "base64url"), SESSION, MACHINE));
  if (!r.ok) throw new Error(r.error);
  return r.grant;
}

describe("the node's files API", () => {
  it("is behind presence and the policy's folders, and answers only types the gate passes", async () => {
    const h = home();
    const presence = await enrol(PASS, Date.now(), 1_000);
    const g = new PresenceGate({ presence, machineId: MACHINE, hours: () => 12, now: Date.now });
    const s = harness(h, JSON.stringify({ files: [{ path: "~/code", mode: "write" }] }), g);
    const list = `/api/files/list?path=${encodeURIComponent(path.join(h.home, "code", "app"))}`;
    expect((await s.ask("GET", list, { kind: "http", session: SESSION, grant: null })).status).toBe(401);
    const grant = await grantFor(g, presence);
    const open = { kind: "http" as const, session: SESSION, grant };
    const listed = await s.ask("GET", list, open);
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.text).entries.map((e: { name: string }) => e.name)).toEqual(["a.txt"]);
    // A file: text inline when asked, a download otherwise; never another type.
    const file = encodeURIComponent(path.join(h.home, "code", "app", "a.txt"));
    const inline = await s.ask("GET", `/api/files/raw?path=${file}&inline=1`, open);
    expect(inline.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(inline.text).toBe("hello\n");
    const dl = await s.ask("GET", `/api/files/raw?path=${file}`, open);
    expect(dl.headers["content-type"]).toBe("application/octet-stream");
    expect(dl.headers["content-disposition"]).toMatch(/^attachment;/);
    const w = await s.ask("POST", "/api/files/write", open, { path: path.join(h.home, "code", "n.txt"), content: "x" });
    expect(w.status).toBe(200);
    expect(w.headers["content-type"]).toBe("application/json");
    expect((await s.ask("GET", `/api/files/zip?path=${file}`, open)).status).toBe(501);
    // Outside the folders: refused.
    expect((await s.ask("GET", `/api/files/list?path=${encodeURIComponent(path.join(h.home, ".ssh"))}`, open)).status).toBe(403);
    // No folders in the policy: nothing at all.
    s.setPolicy(JSON.stringify({ files: [] }));
    const off = await s.ask("GET", list, open);
    expect(off.status).toBe(403);
    expect(JSON.parse(off.text).error).toBe("files_off");
  });

  it("closes an upload in progress when the folders change", async () => {
    const h = home();
    const presence = await enrol(PASS, Date.now(), 1_000);
    const g = new PresenceGate({ presence, machineId: MACHINE, hours: () => 12, now: Date.now });
    const s = harness(h, JSON.stringify({ files: [{ path: "~/code", mode: "write" }] }), g);
    const open = { kind: "http" as const, session: SESSION, grant: await grantFor(g, presence) };
    const started = JSON.parse((await s.ask("POST", "/api/files/uploads", open, { path: path.join(h.home, "code", "big.bin"), size: 1_000_000 })).text);
    const stream = s.dial(open);
    stream.write(`PUT /api/files/uploads/${started.uploadId}?offset=0 HTTP/1.1\r\nHost: m\r\nContent-Length: 1000000\r\n\r\n`);
    stream.write(Buffer.alloc(1000));
    await new Promise((r) => setTimeout(r, 100));
    const closed = new Promise((r) => stream.once("close", r));
    s.setPolicy(JSON.stringify({ files: [{ path: "~/code", mode: "read" }] }));
    expect(s.server.enforce()).toBeGreaterThan(0);
    await closed;
  });
});

describe("apps on a machine", () => {
  const servers: Array<http.Server | net.Server> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function app(handler: http.RequestListener, host = "127.0.0.1"): Promise<number> {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, host, r));
    return (s.address() as net.AddressInfo).port;
  }

  it("registers a port that answers, up to 64, and drops one closed for 60 s", async () => {
    let t = 1_000;
    const up = new Set([3000, 3001]);
    const p = new Previews({ now: () => t, probe: async (port) => up.has(port) });
    const changes: number[] = [];
    p.on("change", () => changes.push(p.list().length));
    expect(await p.register(3000, "web")).toMatchObject({ ok: true, app: { port: 3000, name: "web" } });
    expect(await p.register(4000)).toMatchObject({ ok: false });
    expect(await p.register("x")).toMatchObject({ ok: false });
    expect(await p.register(70000)).toMatchObject({ ok: false });
    for (let i = 0; i < MAX_APPS + 2; i++) up.add(5000 + i);
    for (let i = 1; i < MAX_APPS; i++) expect((await p.register(5000 + i)).ok).toBe(true);
    expect(p.list()).toHaveLength(MAX_APPS);
    expect(await p.register(6000 + MAX_APPS)).toMatchObject({ ok: false });
    // Registering again is not another one.
    expect(await p.register(3000)).toMatchObject({ ok: true, existed: true, app: { name: "web" } });
    up.delete(3000);
    await p.check();
    t += 59_000;
    await p.check();
    expect(p.has(3000)).toBe(true);
    // Back within the minute: kept.
    up.add(3000);
    await p.check();
    up.delete(3000);
    await p.check();
    t += 61_000;
    await p.check();
    expect(p.has(3000)).toBe(false);
    expect(changes.at(-1)).toBe(MAX_APPS - 1);
  });

  it("reaches a registered port and nothing else, on 127.0.0.1 then [::1], never following a redirect", async () => {
    const h = home();
    const presence = await enrol(PASS, Date.now(), 1_000);
    const g = new PresenceGate({ presence, machineId: MACHINE, hours: () => 12, now: Date.now });
    const port = await app((req, res) => {
      if (req.url === "/go") {
        res.writeHead(302, { location: "/elsewhere" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "s=1; Path=/" });
      res.end(`<p>app ${req.url} ${req.headers.host}</p>`);
    });
    let v6: number | null = null;
    try {
      v6 = await app((_q, res) => res.end("on ::1"), "::1");
    } catch {
      // No IPv6 loopback here.
    }
    const s = harness(h, JSON.stringify({ ports: true }), g);
    const appOpen = (p: number): StreamOpen => ({ kind: "http", session: null, grant: null, app: p });
    // Not registered: nothing, whatever port the gate names.
    expect((await s.ask("GET", "/", appOpen(port))).status).toBe(404);
    expect((await s.previews.register(port, "web")).ok).toBe(true);
    const page = await s.ask("GET", "/x?y=1", appOpen(port), undefined, { host: `localhost:${port}` });
    expect(page.status).toBe(200);
    expect(page.text).toBe(`<p>app /x?y=1 localhost:${port}</p>`);
    // Its headers as they came: the gate applies the app policy.
    expect(page.headers["set-cookie"]).toEqual(["s=1; Path=/"]);
    const go = await s.ask("GET", "/go", appOpen(port));
    expect(go.status).toBe(302);
    expect(go.headers.location).toBe("/elsewhere");
    // An app stream reaches the app, never the node's own API; a plain stream never reaches an app.
    expect((await s.ask("GET", "/api/health", appOpen(port))).text).toMatch(/^<p>app \/api\/health/);
    expect((await s.ask("GET", "/", { kind: "http", session: null, grant: null })).status).toBe(404);
    if (v6 !== null) {
      expect((await s.previews.register(v6)).ok).toBe(true);
      expect((await s.ask("GET", "/", appOpen(v6))).text).toBe("on ::1");
    }
    // ports off: refused, and what was registered stays unreachable.
    s.setPolicy(JSON.stringify({ ports: false }));
    expect((await s.ask("GET", "/", appOpen(port))).status).toBe(403);
  });

  it("carries an app's WebSocket", async () => {
    const h = home();
    const presence = await enrol(PASS, Date.now(), 1_000);
    const g = new PresenceGate({ presence, machineId: MACHINE, hours: () => 12, now: Date.now });
    const srv = http.createServer();
    servers.push(srv);
    const wss = new WebSocketServer({ server: srv });
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo ${String(m)}`)));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    const s = harness(h, JSON.stringify({ ports: true }), g);
    expect((await s.previews.register(port)).ok).toBe(true);
    const ws = new WebSocket(`ws://machine/ws`, { createConnection: () => s.dial({ kind: "upgrade", session: null, grant: null, app: port }) as never });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    ws.send("hi");
    const got = await new Promise<string>((r) => ws.once("message", (m) => r(String(m))));
    expect(got).toBe("echo hi");
    const closed = new Promise((r) => ws.once("close", r));
    // Its registration ended: what it had open closes.
    s.previews.remove(port);
    s.server.enforce();
    await closed;
    wss.close();
  });

  it("writes an agentbox-preview shim that runs this program's node preview", () => {
    const dir = tmpDir();
    const file = writePreviewShim(dir, ["/usr/bin/node", "/opt/agent box/agentbox.mjs"]);
    expect(fs.readFileSync(file, "utf8")).toContain(`exec '/usr/bin/node' '/opt/agent box/agentbox.mjs' node preview "$@"`);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o700);
  });
});
