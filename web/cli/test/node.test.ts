import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { decodeControl, decodeFrame, encodeControl, encodeFrame, FrameType, revokeMac, tokenDigest, type ControlMessage } from "@workbench/hostcore/link";
import { parseFolders } from "../src/commands/node.js";
import { BoxClient } from "../src/http.js";
import { callControl, startControl } from "../src/node/control.js";
import { readCredentials } from "../src/node/credentials.js";
import { HERDR_PINS, HERDR_VERSION, installHerdr, sha256 } from "../src/node/install.js";
import { joinMachine, type JoinSteps } from "../src/node/join.js";
import { backoffMs, NodeLink, type LinkState } from "../src/node/link.js";
import { nodeDir, nodePaths } from "../src/node/paths.js";
import { loadPolicy, parsePolicy, setPaused, summarize, watchPolicy, writeInitialPolicy } from "../src/node/policy.js";
import { derive, enrol, PRESENCE_ITERATIONS } from "../src/node/presence.js";
import { execStart, installService, unitText } from "../src/node/service-linux.js";
import { json, stubServer, tmpDir, type Stub } from "./helpers.js";

const HOME = "/home/owner";
const NODE_TOKEN = `abn_${"T".repeat(43)}`;
const mode = (f: string) => (fs.statSync(f).mode & 0o777).toString(8);

describe("policy.json", () => {
  it("reads what the owner wrote, ~ and all", () => {
    const l = parsePolicy(JSON.stringify({ terminals: true, files: [{ path: "~/code", mode: "write" }, { path: "/srv/data", mode: "read" }], presenceHours: 4 }), HOME);
    expect(l.problem).toBeNull();
    expect(l.policy).toEqual({
      terminals: true,
      files: [
        { path: "/home/owner/code", mode: "write" },
        { path: "/srv/data", mode: "read" },
      ],
      ports: false,
      share: false,
      updates: "auto",
      presenceHours: 4,
      paused: false,
    });
    expect(summarize(l).problem).toBeNull();
  });

  it("denies everything when it is missing, broken, or says anything it does not understand", () => {
    for (const [text, why] of [
      ["{", /not valid JSON/],
      ["[]", /not an object/],
      ['{"terminals":"yes"}', /terminals/],
      ['{"files":[{"path":"code","mode":"write"}]}', /absolute/],
      ['{"files":[{"path":"/x","mode":"exec"}]}', /mode/],
      ['{"presenceHours":48}', /presenceHours/],
      ['{"terminals":true,"sudo":true}', /"sudo"/],
    ] as const) {
      const l = parsePolicy(text, HOME);
      expect(l.problem, text).toMatch(why);
      expect(l.policy.terminals || l.policy.files.length > 0 || l.policy.ports || l.policy.share).toBe(false);
    }
    const dir = tmpDir();
    expect(loadPolicy(path.join(dir, "policy.json"), HOME).problem).toMatch(/no policy.json/);
  });

  it("is written by join only when there is none, private; pause changes only its own key", () => {
    const file = path.join(tmpDir(), "node", "policy.json");
    expect(writeInitialPolicy(file, [{ path: "/w", mode: "write" }])).toBe(true);
    expect(mode(file)).toBe("600");
    fs.writeFileSync(file, JSON.stringify({ terminals: false, files: [], ports: true }));
    expect(writeInitialPolicy(file, [])).toBe(false);
    setPaused(file, true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ terminals: false, files: [], ports: true, paused: true });
    fs.writeFileSync(file, "{");
    expect(() => setPaused(file, true)).toThrow(/not valid JSON/);
  });

  it("is watched: a change is seen within the interval", async () => {
    const file = path.join(tmpDir(), "policy.json");
    fs.writeFileSync(file, JSON.stringify({ terminals: true }));
    const seen: boolean[] = [];
    const stop = watchPolicy(file, HOME, (l) => seen.push(l.policy.terminals), 50);
    try {
      // Replaced by a rename, as an editor saves.
      fs.writeFileSync(`${file}.new`, JSON.stringify({ terminals: false }));
      fs.renameSync(`${file}.new`, file);
      const end = Date.now() + 2_000;
      while (seen.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([false]);
    } finally {
      stop();
    }
  });

  it("join's folders are never the whole home", () => {
    expect(parseFolders("~/code, /srv/x:read", HOME)).toEqual([
      { path: "/home/owner/code", mode: "write" },
      { path: "/srv/x", mode: "read" },
    ]);
    expect(() => parseFolders("~", HOME)).toThrow(/whole home/);
  });
});

describe("presence enrolment", () => {
  it("derives K with PBKDF2-SHA256 600 000 and a fresh salt", async () => {
    expect(PRESENCE_ITERATIONS).toBe(600_000);
    const a = await enrol("a long machines passphrase", 1, 1_000);
    const b = await enrol("a long machines passphrase", 1, 1_000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.key).not.toBe(b.key);
    expect((await derive("a long machines passphrase", Buffer.from(a.salt, "base64url"), 1_000)).toString("base64url")).toBe(a.key);
    expect(a).toMatchObject({ algorithm: "PBKDF2-SHA256", iterations: 1_000 });
  });
});

describe("the node folder", () => {
  it("is under XDG_DATA_HOME, or ~/.local/share, or %LOCALAPPDATA%", () => {
    expect(nodeDir({}, HOME, "linux")).toBe("/home/owner/.local/share/agentbox/node");
    expect(nodeDir({ XDG_DATA_HOME: "/data" }, HOME, "linux")).toBe("/data/agentbox/node");
    expect(nodeDir({ LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local" }, "C:\\Users\\o", "win32")).toBe("C:\\Users\\o\\AppData\\Local\\agentbox\\node");
  });
});

describe("installing herdr", () => {
  const script = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/install-herdr.sh"), "utf8");
  it("pins what scripts/install-herdr.sh pins", () => {
    expect(script).toContain(`HERDR_VERSION="\${HERDR_VERSION:-${HERDR_VERSION}}"`);
    for (const pin of Object.values(HERDR_PINS)) {
      expect(script).toContain(`asset="${pin.asset}"`);
      expect(script).toContain(`sha="${pin.sha256}"`);
    }
  });

  it("writes nothing that fails verification", async () => {
    const bin = path.join(tmpDir(), "bin");
    await expect(installHerdr(bin, { platform: "linux", arch: "x64", download: async () => new Uint8Array([1, 2, 3]) })).rejects.toThrow(/failed verification/);
    expect(fs.existsSync(path.join(bin, "herdr"))).toBe(false);
    await expect(installHerdr(bin, { platform: "sunos", arch: "x64" })).rejects.toThrow(/no build/);
  });

  it("keeps a copy that already matches", async () => {
    const bin = tmpDir();
    const pin = HERDR_PINS["linux-x64"] as { sha256: string };
    // No real herdr here: a pin that matches these bytes stands in.
    const bytes = Buffer.from("pretend herdr");
    const saved = pin.sha256;
    pin.sha256 = sha256(bytes);
    try {
      let downloads = 0;
      const download = async () => {
        downloads += 1;
        return bytes;
      };
      await installHerdr(bin, { platform: "linux", arch: "x64", download });
      expect(mode(path.join(bin, "herdr"))).toBe("700");
      await installHerdr(bin, { platform: "linux", arch: "x64", download });
      expect(downloads).toBe(1);
    } finally {
      pin.sha256 = saved;
    }
  });
});

describe("joining", () => {
  let stub: Stub | null = null;
  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  function gate(poll: () => unknown) {
    return stubServer((req, res) => {
      if (req.url === "/_gate/node/join/start") return json(res, 200, { joinCode: "j", userCode: "BCDF-GHJK", expiresIn: 600, interval: 0, name: "laptop", approveAt: "https://machines.example.com/admin" });
      if (req.url === "/_gate/node/join/poll") return json(res, 200, poll());
      json(res, 404, {});
    });
  }

  function steps(s: Stub, order: string[], over: Partial<JoinSteps> = {}): { steps: JoinSteps; err: string[] } {
    const dir = tmpDir();
    const err: string[] = [];
    return {
      err,
      steps: {
        paths: nodePaths(path.join(dir, "node")),
        platform: "linux",
        arch: "x64",
        hostname: "lap",
        now: Date.now,
        err: (t) => err.push(t),
        client: new BoxClient(s.url, null),
        freeBytes: () => 10 * 2 ** 30,
        install: async () => void order.push("install"),
        passphrase: async () => (order.push("passphrase"), "a long machines passphrase"),
        enrol: async () => (order.push("enrol"), { algorithm: "PBKDF2-SHA256", iterations: 1, salt: "s", key: "k", createdAt: 1 }),
        sleep: async () => {},
        askFolders: async () => (order.push("folders"), [{ path: "/w", mode: "write" }]),
        service: async () => void order.push("service"),
        waitOnline: async () => (order.push("online"), true),
        printPolicy: () => order.push("print"),
        ...over,
      },
    };
  }

  it("goes in the spec's order, and writes the token only once it is approved", async () => {
    let polls = 0;
    stub = await gate(() => (++polls < 2 ? { status: "pending" } : { status: "approved", token: NODE_TOKEN, machineId: "m1", name: "laptop" }));
    const order: string[] = [];
    const { steps: s, err } = steps(stub, order);
    const creds = await joinMachine({ box: stub.url, name: "laptop", folders: null }, s);
    expect(order).toEqual(["install", "passphrase", "enrol", "folders", "print", "service", "online"]);
    expect(creds).toMatchObject({ box: stub.url, machineId: "m1", token: NODE_TOKEN });
    expect(readCredentials(s.paths.credentials)?.machineId).toBe("m1");
    expect(mode(s.paths.credentials)).toBe("600");
    expect(mode(s.paths.dir)).toBe("700");
    // The code is shown, and no link carries it.
    const shown = err.join("");
    expect(shown).toContain("BCDF-GHJK");
    expect(shown).not.toMatch(/https?:\/\/\S*BCDF/);
    // Install and passphrase came before the box heard of this machine.
    const start = JSON.parse(stub.seen.find((x) => x.url === "/_gate/node/join/start")?.body.toString() ?? "{}");
    expect(start).toEqual({ name: "laptop", platform: "linux", arch: "x64", hostname: "lap" });
  });

  it("leaves no token behind when installing fails, and asks the box nothing", async () => {
    stub = await gate(() => ({ status: "approved", token: NODE_TOKEN, machineId: "m1", name: "laptop" }));
    const order: string[] = [];
    const { steps: s } = steps(stub, order, { install: async () => Promise.reject(new Error("verification failed")) });
    await expect(joinMachine({ box: stub.url, name: "laptop", folders: null }, s)).rejects.toThrow(/verification/);
    expect(stub.seen).toHaveLength(0);
    expect(fs.existsSync(s.paths.credentials)).toBe(false);
    expect(fs.existsSync(s.paths.policy)).toBe(false);
  });

  it("writes nothing when the join is denied", async () => {
    stub = await gate(() => ({ status: "denied" }));
    const { steps: s } = steps(stub, []);
    await expect(joinMachine({ box: stub.url, name: "laptop", folders: null }, s)).rejects.toThrow(/denied/);
    expect(fs.existsSync(s.paths.credentials)).toBe(false);
  });

  it("refuses unsupported platforms and a second box; re-joins this box with proof of the old token", async () => {
    stub = await gate(() => ({ status: "approved", token: `abn_${"U".repeat(43)}`, machineId: "m1", name: "laptop" }));
    const order: string[] = [];
    const { steps: s } = steps(stub, order);
    await expect(joinMachine({ box: stub.url, name: "x", folders: null }, { ...s, platform: "aix" })).rejects.toThrow(/not supported/);
    expect(order).toEqual([]);
    await joinMachine({ box: stub.url, name: "laptop", folders: [{ path: "/w", mode: "write" }] }, s);
    const policyBefore = fs.readFileSync(s.paths.policy, "utf8");
    await expect(joinMachine({ box: "https://other.example.com", name: "x", folders: null }, s)).rejects.toThrow(/joined to .* already/);
    const old = readCredentials(s.paths.credentials)?.token;
    await joinMachine({ box: stub.url, name: "laptop", folders: [{ path: "/elsewhere", mode: "read" }] }, s);
    const starts = stub.seen.filter((x) => x.url === "/_gate/node/join/start").map((x) => JSON.parse(x.body.toString()));
    expect(starts[1]?.rejoin).toEqual({ machineId: "m1", token: old });
    // Re-joining never rewrites the policy.
    expect(fs.readFileSync(s.paths.policy, "utf8")).toBe(policyBefore);
  });
});

/** A stand-in for the gate's link endpoint, whose answers each test decides. */
async function fakeGate(onHello: (ws: WebSocket, hello: ControlMessage, n: number) => void, status: () => number = () => 101) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  const auth: string[] = [];
  server.on("upgrade", (req, socket, head) => {
    auth.push(String(req.headers.authorization));
    const s = status();
    if (s !== 101) {
      socket.end(`HTTP/1.1 ${s} Nope\r\nContent-Length: 0\r\n\r\n`);
      connections += 1;
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const n = ++connections;
      ws.once("message", (d: Buffer) => onHello(ws, decodeControl(decodeFrame(d).payload), n));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get connections() {
      return connections;
    },
    auth,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const policySummary = summarize(parsePolicy("{}", HOME));
function newLink(url: string, over: Partial<ConstructorParameters<typeof NodeLink>[0]> = {}): { link: NodeLink; states: LinkState[] } {
  const link = new NodeLink({
    box: url,
    token: NODE_TOKEN,
    machineId: "m1",
    version: "0.1.0",
    describe: async () => ({ platform: "linux", arch: "x64", hostname: "lap", cpu: { model: "", cores: 1 }, ramBytes: 1, disks: [], gpus: [], docker: false, claude: null, policy: policySummary }),
    minBackoffMs: 20,
    maxBackoffMs: 40,
    duplicateBackoffMs: 400,
    ...over,
  });
  const states: LinkState[] = [];
  link.on("state", (s: LinkState) => states.push(s));
  return { link, states };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the node's link", () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it("backs off from 1 s to 60 s, jittered", () => {
    expect(backoffMs(1, 1_000, 60_000, () => 1)).toBe(1_000);
    expect(backoffMs(1, 1_000, 60_000, () => 0)).toBe(500);
    expect(backoffMs(3, 1_000, 60_000, () => 1)).toBe(4_000);
    expect(backoffMs(30, 1_000, 60_000, () => 1)).toBe(60_000);
  });

  it("says hello with its token and comes online", async () => {
    const g = await fakeGate((ws, hello) => {
      expect(hello).toMatchObject({ type: "hello", protocol: 1, version: "0.1.0", hostname: "lap" });
      expect(String(hello.nonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      ws.send(encodeControl({ type: "ok", machineId: "m1", name: "laptop" }));
      // A stream opened while nothing serves streams: refused with its close.
      ws.send(encodeFrame(FrameType.open, 3, Buffer.from("{}")));
      ws.on("message", (d: Buffer) => {
        const f = decodeFrame(d);
        if (f.type === FrameType.close) closed.push(f.stream);
      });
    });
    const closed: number[] = [];
    cleanup.push(() => g.close());
    const { link, states } = newLink(g.url);
    cleanup.push(() => link.stop());
    link.start();
    await until(() => link.state === "online");
    expect(g.auth[0]).toBe(`Bearer ${NODE_TOKEN}`);
    expect(states).toEqual(["connecting", "online"]);
    await until(() => closed.includes(3));
  });

  it("is revoked only by a revoked signed for this machine and this link", async () => {
    let signed = false;
    const g = await fakeGate((ws, hello, n) => {
      const nonce = String(hello.nonce);
      // First a forgery, then a replay of another link's, then the real one.
      const mac = n === 1 ? "0".repeat(64) : n === 2 ? revokeMac(tokenDigest(NODE_TOKEN), "m1", "x".repeat(43)) : revokeMac(tokenDigest(NODE_TOKEN), "m1", nonce);
      if (n >= 3) signed = true;
      ws.send(encodeControl({ type: "revoked", machineId: "m1", mac }));
    });
    cleanup.push(() => g.close());
    const { link } = newLink(g.url);
    let revoked = 0;
    link.on("revoked", () => (revoked += 1));
    link.start();
    await until(() => link.state === "revoked");
    expect(signed).toBe(true);
    expect(revoked).toBe(1);
    expect(g.connections).toBe(3);
    await new Promise((r) => setTimeout(r, 150));
    expect(g.connections).toBe(3);
  });

  it("stops as left only when it asked to leave: a close saying so unasked is a dropped link", async () => {
    const g = await fakeGate((ws, _h, n) => {
      ws.send(encodeControl({ type: "ok", machineId: "m1", name: "laptop" }));
      if (n === 1) setTimeout(() => ws.close(4005, "left"), 20);
      else ws.on("message", (d: Buffer) => decodeControl(decodeFrame(d).payload).type === "leave" && ws.close(4005, "left"));
    });
    cleanup.push(() => g.close());
    const { link } = newLink(g.url);
    cleanup.push(() => link.stop());
    link.start();
    await until(() => g.connections >= 2 && link.state === "online");
    expect(await link.leave()).toBe(true);
    await until(() => link.state === "left");
  });

  it("takes a 401 or a proxy's page for a network failure, and retries", async () => {
    let status = 401;
    const g = await fakeGate((ws) => ws.send(encodeControl({ type: "ok", machineId: "m1", name: "laptop" })), () => status);
    cleanup.push(() => g.close());
    const { link, states } = newLink(g.url);
    cleanup.push(() => link.stop());
    link.start();
    await until(() => g.connections >= 2);
    status = 200;
    await until(() => g.connections >= 3);
    status = 101;
    await until(() => link.state === "online");
    expect(states).not.toContain("revoked");
  });

  it("waits out a duplicate before trying again", async () => {
    const g = await fakeGate((ws, _h, n) => {
      if (n === 1) ws.send(encodeControl({ type: "duplicate", retryAfterMs: 300_000, message: "dup" }));
      else ws.send(encodeControl({ type: "ok", machineId: "m1", name: "laptop" }));
      if (n === 1) ws.close(4002);
    });
    cleanup.push(() => g.close());
    const { link } = newLink(g.url);
    cleanup.push(() => link.stop());
    link.start();
    await until(() => link.state === "duplicate");
    await new Promise((r) => setTimeout(r, 200));
    expect(g.connections).toBe(1);
    await until(() => link.state === "online", 2_000);
  });

  it("reconnects at once when the clock jumps (the machine woke)", async () => {
    let status = 503;
    const g = await fakeGate((ws) => ws.send(encodeControl({ type: "ok", machineId: "m1", name: "laptop" })), () => status);
    cleanup.push(() => g.close());
    let clock = 1_000_000;
    const { link } = newLink(g.url, { minBackoffMs: 600_000, maxBackoffMs: 600_000, now: () => clock, wakeCheckMs: 20, wakeJumpMs: 1_000 });
    cleanup.push(() => link.stop());
    link.start();
    await until(() => g.connections === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(g.connections).toBe(1);
    status = 101;
    clock += 60_000;
    await until(() => link.state === "online", 2_000);
  });

  it("pauses: says so, closes, and stays closed until resume", async () => {
    const said: string[] = [];
    const g = await fakeGate((ws) => {
      ws.send(encodeControl({ type: "ok", machineId: "m1", name: "laptop" }));
      ws.on("message", (d: Buffer) => said.push(decodeControl(decodeFrame(d).payload).type));
    });
    cleanup.push(() => g.close());
    const { link } = newLink(g.url);
    cleanup.push(() => link.stop());
    link.start();
    await until(() => link.state === "online");
    link.pause();
    await until(() => said.includes("pause"));
    await new Promise((r) => setTimeout(r, 150));
    expect(g.connections).toBe(1);
    expect(link.state).toBe("paused");
    link.resume();
    await until(() => link.state === "online");
    expect(g.connections).toBe(2);
  });
});

describe("the control socket", () => {
  it("answers only requests carrying the secret, on a private socket", async () => {
    const dir = tmpDir();
    const sock = path.join(dir, "control.sock");
    const secret = path.join(dir, "control.secret");
    const server = await startControl(sock, secret, async (c) => ({ asked: c }));
    try {
      expect(mode(sock)).toBe("600");
      expect(mode(secret)).toBe("600");
      expect(await callControl(sock, secret, "status")).toEqual({ ok: true, asked: "status" });
      fs.writeFileSync(path.join(dir, "wrong"), "nope");
      expect(await callControl(sock, path.join(dir, "wrong"), "status")).toEqual({ ok: false, error: "refused" });
    } finally {
      server.close();
    }
    expect(await callControl(sock, secret, "status")).toBeNull();
  });
});

describe("the service", () => {
  it("is a user unit restarted only on failure", async () => {
    expect(execStart("/usr/bin/node", "/home/o/.local/bin/agentbox")).toEqual(["/usr/bin/node", "/home/o/.local/bin/agentbox", "node", "run"]);
    expect(execStart("/opt/agentbox", "/opt/agentbox")).toEqual(["/opt/agentbox", "node", "run"]);
    const text = unitText(["/usr/bin/node", "/x y/agentbox", "node", "run"]);
    expect(text).toContain('ExecStart="/usr/bin/node" "/x y/agentbox" "node" "run"');
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain("WantedBy=default.target");
  });

  it("says how it runs when lingering is refused", async () => {
    const calls: string[] = [];
    const config = tmpDir();
    const r = await installService({
      command: ["/usr/bin/node", "/a", "node", "run"],
      user: "owner",
      env: { XDG_CONFIG_HOME: config },
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return cmd === "loginctl" ? { code: 1, stdout: "", stderr: "denied" } : { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable agentbox-node.service",
      "systemctl --user restart agentbox-node.service",
      "loginctl enable-linger owner",
    ]);
    expect(r.lingering).toBe(false);
    expect(r.note).toMatch(/while you are logged in/);
    expect(r.note).toContain("@reboot '/usr/bin/node' '/a' 'node' 'run'");
    expect(fs.existsSync(path.join(config, "systemd", "user", "agentbox-node.service"))).toBe(true);
  });
});
