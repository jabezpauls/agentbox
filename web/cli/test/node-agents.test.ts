import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { decodeFrame, StreamTable, type StreamOpen } from "@workbench/hostcore/link";
import { agentsText, CLAUDE_PINS, CLAUDE_VERSION, claudePaths, holdToken, installClaude, prepareClaude, seedClaudeConfig } from "../src/node/claude.js";
import { nodePaths } from "../src/node/paths.js";
import { parsePolicy, type LoadedPolicy } from "../src/node/policy.js";
import { enrol, LOCK_MS, PresenceGate, presenceAnswer } from "../src/node/presence.js";
import { NodeServer } from "../src/node/server.js";
import { sha256 } from "../src/node/install.js";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION = "a".repeat(24);
const MACHINE = "b".repeat(24);
// Generated per run: never a real passphrase.
const PASS = `test-pass-${randomBytes(6).toString("hex")}`;

async function gate(now: () => number, hours = 12) {
  const presence = await enrol(PASS, now(), 1_000);
  return { presence, gate: new PresenceGate({ presence, machineId: MACHINE, hours: () => hours, now }) };
}

/** What the browser computes (WebCrypto there; the same derivation here). */
async function answerFor(passphrase: string, salt: string, iterations: number, challenge: string, session = SESSION, machine = MACHINE): Promise<string> {
  const { derive } = await import("../src/node/presence.js");
  const key = await derive(passphrase, Buffer.from(salt, "base64url"), iterations);
  return presenceAnswer(key, Buffer.from(challenge, "base64url"), session, machine);
}

describe("presence", () => {
  it("answers a right proof with a grant bound to the session", async () => {
    let t = 1_000_000;
    const { gate: g } = await gate(() => t);
    const c = g.challenge(SESSION);
    if (!c || "locked" in c) throw new Error("no challenge");
    expect(Buffer.from(c.challenge, "base64url")).toHaveLength(32);
    const r = g.answer(SESSION, c.challenge, await answerFor(PASS, c.salt, c.iterations, c.challenge));
    if (!r.ok) throw new Error(r.error);
    expect(g.check(r.grant, SESSION)).toBe(true);
    // Another machines session holding the same grant gets nothing.
    expect(g.check(r.grant, "c".repeat(24))).toBe(false);
    expect(g.check(null, SESSION)).toBe(false);
    // Lasts presenceHours from its issue.
    t += 11 * 3600_000;
    const hold = g.hold(r.grant);
    t += 2 * 3600_000;
    expect(g.check(r.grant, SESSION)).toBe(false);
    hold();
  });

  it("takes each challenge once, within 60 s, for the session it was given to", async () => {
    let t = 5_000_000;
    const { gate: g } = await gate(() => t);
    const c = g.challenge(SESSION) as { challenge: string; salt: string; iterations: number };
    const right = await answerFor(PASS, c.salt, c.iterations, c.challenge);
    // For another session: refused (and spent).
    expect(g.answer("c".repeat(24), c.challenge, right)).toMatchObject({ ok: false, error: "expired" });
    expect(g.answer(SESSION, c.challenge, right)).toMatchObject({ ok: false, error: "expired" });
    const c2 = g.challenge(SESSION) as { challenge: string };
    t += 61_000;
    expect(g.answer(SESSION, c2.challenge, await answerFor(PASS, c.salt, c.iterations, c2.challenge))).toMatchObject({ ok: false, error: "expired" });
    // An answer bound to another machine is wrong here.
    const c3 = g.challenge(SESSION) as { challenge: string };
    expect(g.answer(SESSION, c3.challenge, await answerFor(PASS, c.salt, c.iterations, c3.challenge, SESSION, "d".repeat(24)))).toMatchObject({ ok: false, error: "wrong" });
    const c4 = g.challenge(SESSION) as { challenge: string };
    const ok = g.answer(SESSION, c4.challenge, await answerFor(PASS, c.salt, c.iterations, c4.challenge));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    // Idle 30 minutes with nothing open: ended.
    t += 31 * 60_000;
    expect(g.check(ok.grant, SESSION)).toBe(false);
  });

  it("locks for 15 minutes after five wrong answers in ten, right answers included", async () => {
    let t = 9_000_000;
    const lines: string[] = [];
    const presence = await enrol(PASS, t, 1_000);
    const g = new PresenceGate({ presence, machineId: MACHINE, hours: () => 12, now: () => t, log: (l) => lines.push(l) });
    for (let i = 0; i < 4; i++) {
      const c = g.challenge(SESSION) as { challenge: string };
      expect(g.answer(SESSION, c.challenge, await answerFor("not it at all", presence.salt, presence.iterations, c.challenge))).toMatchObject({ error: "wrong", failures: i + 1 });
      t += 60_000;
    }
    const c = g.challenge(SESSION) as { challenge: string };
    expect(g.answer(SESSION, c.challenge, "AAAA")).toMatchObject({ ok: false, error: "locked" });
    expect(lines.join("\n")).toMatch(/locked for 15 minutes/);
    expect(g.challenge(SESSION)).toMatchObject({ locked: true });
    t += LOCK_MS - 1_000;
    expect(g.locked()).not.toBeNull();
    t += 2_000;
    const again = g.challenge(SESSION) as { challenge: string };
    expect(g.answer(SESSION, again.challenge, await answerFor(PASS, presence.salt, presence.iterations, again.challenge)).ok).toBe(true);
  });

  it("takes a new passphrase at once: the old one answers nothing, and what it granted ends", async () => {
    const t = 12_000_000;
    const { gate: g, presence } = await gate(() => t);
    const c = g.challenge(SESSION) as { challenge: string; salt: string; iterations: number };
    const r = g.answer(SESSION, c.challenge, await answerFor(PASS, c.salt, c.iterations, c.challenge));
    if (!r.ok) throw new Error(r.error);
    const pending = g.challenge(SESSION) as { challenge: string };
    const NEW = `${PASS}-new`;
    const fresh = await enrol(NEW, t, 1_000);
    g.rekey(fresh);
    expect(g.check(r.grant, SESSION)).toBe(false);
    expect(g.answer(SESSION, pending.challenge, await answerFor(PASS, presence.salt, presence.iterations, pending.challenge))).toMatchObject({ ok: false, error: "expired" });
    const c2 = g.challenge(SESSION) as { challenge: string; salt: string; iterations: number };
    expect(c2.salt).toBe(fresh.salt);
    expect(g.answer(SESSION, c2.challenge, await answerFor(PASS, presence.salt, presence.iterations, c2.challenge))).toMatchObject({ ok: false, error: "wrong" });
    const c3 = g.challenge(SESSION) as { challenge: string; salt: string; iterations: number };
    expect(g.answer(SESSION, c3.challenge, await answerFor(NEW, c3.salt, c3.iterations, c3.challenge)).ok).toBe(true);
  });
});

/** The node's server fed streams the way the link feeds it, from a gate-side table. */
function harness(policyText: string, presence: PresenceGate, herdrSocket: string | null = null) {
  let policy: LoadedPolicy = parsePolicy(policyText, "/home/owner");
  const server = new NodeServer({
    herdrSocket: () => herdrSocket,
    hub: () => null,
    streams: () => null,
    policy: () => policy,
    presence,
    home: "/home/owner",
  });
  const ends: { gate?: StreamTable; node?: StreamTable } = {};
  ends.gate = new StreamTable((f) => setImmediate(() => ends.node?.receive(decodeFrame(f))));
  ends.node = new StreamTable((f) => setImmediate(() => ends.gate?.receive(decodeFrame(f))));
  let id = 0;
  const ask = (method: string, p: string, open: StreamOpen, body?: object) =>
    new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          method,
          path: p,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
          createConnection: (_o, cb) => {
            id += 1;
            const near = ends.gate?.open(id);
            server.accept(ends.node?.open(id) as never, open);
            cb(null, near as never);
            return undefined;
          },
        },
        (res) => {
          let t = "";
          res.on("data", (c: Buffer) => (t += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(t || "{}") as Record<string, unknown> }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  return {
    server,
    ask,
    setPolicy: (text: string) => {
      policy = parsePolicy(text, "/home/owner");
    },
  };
}

describe("the node's server", () => {
  async function granted(g: PresenceGate, salt: string, iterations: number, h: ReturnType<typeof harness>): Promise<string> {
    const open = { kind: "http" as const, session: SESSION, grant: null };
    const c = await h.ask("POST", "/presence/challenge", open);
    expect(c.status).toBe(200);
    const challenge = c.json.challenge as string;
    const r = await h.ask("POST", "/presence/answer", open, { challenge, answer: await answerFor(PASS, salt, iterations, challenge) });
    expect(r.status).toBe(200);
    return r.json.grant as string;
  }

  it("opens herdr's API to a live grant only, and with terminals on only", async () => {
    const { presence, gate: g } = await gate(Date.now);
    const h = harness(JSON.stringify({ terminals: true }), g);
    const none = await h.ask("POST", "/api/rpc", { kind: "http", session: SESSION, grant: null }, { method: "ping" });
    expect(none.status).toBe(401);
    expect(none.json.error).toBe("presence");
    // A grant the gate made up opens nothing.
    expect((await h.ask("GET", "/api/session", { kind: "http", session: SESSION, grant: "pg_forged" })).status).toBe(401);
    const grant = await granted(g, presence.salt, presence.iterations, h);
    // Granted, but herdr is not up: no longer a presence refusal.
    expect((await h.ask("POST", "/api/rpc", { kind: "http", session: SESSION, grant }, { method: "ping" })).status).toBe(503);
    // The health check is not gated.
    expect((await h.ask("GET", "/api/health", { kind: "http", session: null, grant: null })).json).toMatchObject({ ok: true, machine: { terminals: true } });
    h.setPolicy(JSON.stringify({ terminals: false }));
    const off = await h.ask("POST", "/api/rpc", { kind: "http", session: SESSION, grant }, { method: "ping" });
    expect(off.status).toBe(403);
    expect(off.json.error).toBe("terminals_off");
    h.server.close();
  });

  it("refuses herdr methods the allowlist does not name", async () => {
    const { presence, gate: g } = await gate(Date.now);
    const h = harness(JSON.stringify({ terminals: true }), g, "/nonexistent/herdr.sock");
    const grant = await granted(g, presence.salt, presence.iterations, h);
    expect((await h.ask("POST", "/api/rpc", { kind: "http", session: SESSION, grant }, { method: "server.stop" })).status).toBe(403);
    expect((await h.ask("POST", "/api/rpc", { kind: "http", session: SESSION, grant }, { method: "pane.graphics.frame" })).status).toBe(403);
    h.server.close();
  });

  it("closes open channels when the policy tightens", async () => {
    const { presence, gate: g } = await gate(Date.now);
    const h = harness(JSON.stringify({ terminals: true }), g, "/nonexistent/herdr.sock");
    const grant = await granted(g, presence.salt, presence.iterations, h);
    // A channel held open: a request whose body never ends.
    const closed = new Promise<string>((resolve) => {
      const req = http.request({
        method: "POST",
        path: "/api/rpc",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        createConnection: (_o, cb) => {
          const ends = { gate: null as StreamTable | null, node: null as StreamTable | null };
          ends.gate = new StreamTable((f) => setImmediate(() => ends.node?.receive(decodeFrame(f))));
          ends.node = new StreamTable((f) => setImmediate(() => ends.gate?.receive(decodeFrame(f))));
          const near = ends.gate.open(99);
          h.server.accept(ends.node.open(99), { kind: "http", session: SESSION, grant });
          cb(null, near);
          return undefined;
        },
      });
      req.on("error", () => resolve("closed"));
      req.on("response", (res) => {
        res.resume();
        res.on("close", () => resolve("closed"));
      });
      req.write("{");
    });
    for (let i = 0; i < 50 && h.server.openChannels === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.server.openChannels).toBe(1);
    expect(h.server.enforce()).toBe(0);
    h.setPolicy(JSON.stringify({ terminals: false }));
    expect(h.server.enforce()).toBe(1);
    expect(await closed).toBe("closed");
    expect(h.server.openChannels).toBe(0);
    h.server.close();
  });

  it("refuses a terminal socket without a grant", async () => {
    const { gate: g } = await gate(Date.now);
    const h = harness(JSON.stringify({ terminals: true }), g);
    const ends = { gate: null as StreamTable | null, node: null as StreamTable | null };
    ends.gate = new StreamTable((f) => setImmediate(() => ends.node?.receive(decodeFrame(f))));
    ends.node = new StreamTable((f) => setImmediate(() => ends.gate?.receive(decodeFrame(f))));
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket("ws://machine/ws/terminal", {
        createConnection: () => {
          const near = (ends.gate as StreamTable).open(5);
          h.server.accept((ends.node as StreamTable).open(5), { kind: "upgrade", session: SESSION, grant: null });
          return near as never;
        },
      });
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(-1));
    });
    expect(status).toBe(401);
    h.server.close();
  });
});

describe("Claude Code on a machine", () => {
  it("seeds its own config folder once, so it starts straight at its prompt", () => {
    const p = nodePaths(path.join(tmpDir(), "node"));
    const c = claudePaths(p, "linux");
    seedClaudeConfig(c, "/home/owner");
    expect(JSON.parse(fs.readFileSync(path.join(c.config, ".claude.json"), "utf8"))).toEqual({ hasCompletedOnboarding: true, projects: { "/home/owner": { hasTrustDialogAccepted: true } } });
    expect(JSON.parse(fs.readFileSync(path.join(c.config, "settings.json"), "utf8"))).toEqual({ disableDeepLinkRegistration: "disable" });
    // Claude Code rewrites it; the node never does again.
    fs.writeFileSync(path.join(c.config, ".claude.json"), "{}");
    seedClaudeConfig(c, "/home/owner");
    expect(fs.readFileSync(path.join(c.config, ".claude.json"), "utf8")).toBe("{}");
  });

  it("runs the real binary through a shim that reads the shared token at each launch", () => {
    const p = nodePaths(path.join(tmpDir(), "node"));
    const c = claudePaths(p, "linux");
    prepareClaude(c, { home: "/home/owner", machine: "laptop" });
    expect(fs.readFileSync(c.agents, "utf8")).toContain("You are working on laptop");
    // A stub in place of the real Claude Code: it says what it was given.
    fs.mkdirSync(p.bin, { recursive: true });
    fs.writeFileSync(
      c.bin,
      '#!/bin/sh\necho "token=${CLAUDE_CODE_OAUTH_TOKEN:-none} config=$CLAUDE_CONFIG_DIR updates=$DISABLE_UPDATES args=$*"\n',
      { mode: 0o755 },
    );
    const run = (...args: string[]) => execFileSync(c.shim, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }).trim();
    expect(run("hello")).toBe(`token=none config=${c.config} updates=1 args=--append-system-prompt-file ${c.agents} hello`);
    const token = `tok-${randomBytes(12).toString("hex")}`;
    holdToken(c, token);
    expect((fs.statSync(c.token).mode & 0o777).toString(8)).toBe("600");
    expect(run()).toContain(`token=${token} `);
    // Subcommands take no session flags.
    expect(run("--version")).toBe(`token=${token} config=${c.config} updates=1 args=--version`);
    holdToken(c, null);
    expect(run()).toContain("token=none");
  });

  it("names the machine in agentbox's instructions, and nothing else", () => {
    const text = agentsText("lap$(rm -rf)top");
    expect(text).toContain("You are working on laprm-rftop");
    expect(text).not.toMatch(/\$\(|\{\{/);
    expect(text).toMatch(/never make anything public/i);
  });

  it("pins the same builds the signed machines manifest carries", () => {
    const script = fs.readFileSync(path.join(here, "..", "scripts", "machines-manifest.mjs"), "utf8");
    expect(script).toContain(`const CLAUDE_VERSION = "${CLAUDE_VERSION}"`);
    for (const [k, pin] of Object.entries(CLAUDE_PINS)) {
      const key = k === "win32-x64" ? "win-x64" : k;
      expect(script).toContain(`"${key}": { path: "${pin.path}", sha256: "${pin.sha256}", size: ${pin.size} }`);
    }
  });

  it("installs only what matches the pin, and keeps one at least as new", async () => {
    const p = nodePaths(path.join(tmpDir(), "node"));
    const c = claudePaths(p, "linux");
    const fake = Buffer.from("not claude code");
    const fetch = (async () => new Response(fake)) as typeof globalThis.fetch;
    await expect(installClaude(c, { platform: "linux", arch: "x64", fetch })).rejects.toThrow(/does not match/);
    expect(fs.existsSync(c.bin)).toBe(false);
    expect(sha256(fake)).not.toBe(CLAUDE_PINS["linux-x64"]?.sha256);
    fs.mkdirSync(p.bin, { recursive: true });
    fs.writeFileSync(c.bin, "newer", { mode: 0o755 });
    fs.writeFileSync(c.versionFile, "2.2.0\n");
    expect(await installClaude(c, { platform: "linux", arch: "x64", fetch })).toBe("2.2.0");
  });
});
