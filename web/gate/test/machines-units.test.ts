import fs from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { MACHINES_COOKIE } from "../src/cookies.js";
import { Handoffs, HANDOFF_MS } from "../src/machines/handoff.js";
import { MACHINES_HEADERS, machinesRequestRefusal } from "../src/machines/headers.js";
import { PassphraseError, clearMachines, passphraseProblem, setPassphrase } from "../src/machines/passphrase.js";
import { MACHINES_ABSOLUTE_MS, MACHINES_IDLE_MS, MachinesSessions } from "../src/machines/session.js";
import { hashPassword } from "../src/password.js";
import { Store } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function store(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-machines-"));
  dirs.push(dir);
  return Store.open(dir, await hashPassword("the main password", 4));
}

function clock(start = 1_750_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const cookie = (secret: string) => `${MACHINES_COOKIE}=${secret}`;

describe("machines sessions", () => {
  it("are found by their own cookie only, and carry the machines audience", async () => {
    const s = await store();
    const sessions = new MachinesSessions(s);
    const { secret, record } = await sessions.create({ ip: "1", userAgent: "ua" });
    expect(record.aud).toBe("machines");
    expect(sessions.authenticate(cookie(secret), "1")?.id).toBe(record.id);
    // The same secret under the main cookie's name, or nothing at all, is no session.
    expect(sessions.authenticate(`__Host-agentbox=${secret}`, "1")).toBeNull();
    expect(sessions.authenticate(undefined, "1")).toBeNull();
    expect(sessions.authenticate(cookie("x".repeat(43)), "1")).toBeNull();
  });

  it("are never main sessions, nor main sessions machines ones", async () => {
    const s = await store();
    const auth = new Auth(s);
    const sessions = new MachinesSessions(s);
    const main = await auth.createSession({ remember: false, ip: "1", userAgent: "" });
    expect(main.session.aud).toBe("main");
    expect(sessions.authenticate(cookie(main.secret), "1")).toBeNull();
    const m = await sessions.create({ ip: "1", userAgent: "" });
    const req = { headers: { cookie: `__Host-agentbox=${m.secret}` } } as IncomingMessage;
    expect(auth.authenticate(req, "1")).toBeNull();
    expect(auth.listSessions().map((x) => x.id)).toEqual([main.session.id]);
  });

  it("end after 30 idle minutes, and after 12 hours however busy", async () => {
    const s = await store();
    const c = clock();
    const sessions = new MachinesSessions(s, c.now);
    const { secret } = await sessions.create({ ip: "1", userAgent: "" });
    c.advance(MACHINES_IDLE_MS - 1000);
    expect(sessions.authenticate(cookie(secret), "1")).not.toBeNull();
    c.advance(MACHINES_IDLE_MS - 1000);
    expect(sessions.authenticate(cookie(secret), "1")).not.toBeNull();
    c.advance(MACHINES_IDLE_MS + 1);
    expect(sessions.authenticate(cookie(secret), "1")).toBeNull();

    const busy = await sessions.create({ ip: "1", userAgent: "" });
    for (let t = 0; t < MACHINES_ABSOLUTE_MS; t += 10 * 60_000) {
      c.advance(10 * 60_000);
      if (t + 10 * 60_000 < MACHINES_ABSOLUTE_MS) expect(sessions.authenticate(cookie(busy.secret), "1")).not.toBeNull();
    }
    expect(sessions.authenticate(cookie(busy.secret), "1")).toBeNull();
  });

  it("end with a sign-out, and with whatever ends every main session", async () => {
    const s = await store();
    const auth = new Auth(s);
    const sessions = new MachinesSessions(s);
    const a = await sessions.create({ ip: "1", userAgent: "" });
    expect(await sessions.end(a.record.id)).toBe(true);
    expect(sessions.authenticate(cookie(a.secret), "1")).toBeNull();
    const b = await sessions.create({ ip: "1", userAgent: "" });
    const main = await auth.createSession({ remember: false, ip: "1", userAgent: "" });
    // A password change keeps the caller's main session, and ends every machines one.
    await auth.endSessions(main.session.id);
    expect(sessions.authenticate(cookie(b.secret), "1")).toBeNull();
  });

  it("are held to a few at a time, the least recently used going first", async () => {
    const s = await store();
    const c = clock();
    const sessions = new MachinesSessions(s, c.now);
    const first = await sessions.create({ ip: "1", userAgent: "" });
    for (let i = 0; i < 20; i++) {
      c.advance(1000);
      await sessions.create({ ip: "1", userAgent: "" });
    }
    expect(s.data.machines.sessions.length).toBeLessThanOrEqual(10);
    expect(sessions.authenticate(cookie(first.secret), "1")).toBeNull();
  });
});

describe("the handoff nonce", () => {
  it("is random, single use and bound to the main session it was issued for", () => {
    const h = new Handoffs();
    const n = h.issue("main-1");
    expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.issue("main-1")).not.toBe(n);
    expect(h.peek(n)).toBe(true);
    expect(h.take(n)).toBe("main-1");
    expect(h.take(n)).toBeNull();
    expect(h.peek(n)).toBe(false);
    expect(h.take("nope")).toBeNull();
  });

  it("lasts 60 seconds", () => {
    const c = clock();
    const h = new Handoffs(c.now);
    const n = h.issue("main-1");
    c.advance(HANDOFF_MS + 1);
    expect(h.peek(n)).toBe(false);
    expect(h.take(n)).toBeNull();
  });

  it("is held to a few outstanding at a time", () => {
    const h = new Handoffs();
    const first = h.issue("m");
    for (let i = 0; i < 200; i++) h.issue("m");
    expect(h.size).toBeLessThanOrEqual(64);
    expect(h.take(first)).toBeNull();
  });
});

describe("the machines passphrase", () => {
  it("is long enough, fits bcrypt, and is not the sign-in password", async () => {
    expect(passphraseProblem("short")).toMatch(/at least/);
    expect(passphraseProblem("x".repeat(73))).toMatch(/at most/);
    expect(passphraseProblem("a long enough passphrase")).toBeNull();
    const s = await store();
    await expect(setPassphrase({ store: s, cost: 4 }, "the main password")).rejects.toThrow(PassphraseError);
    await expect(setPassphrase({ store: s, cost: 4 }, "short")).rejects.toThrow(PassphraseError);
  });

  it("is stored as bcrypt, and setting it ends every machines session", async () => {
    const s = await store();
    const sessions = new MachinesSessions(s);
    const a = await sessions.create({ ip: "1", userAgent: "" });
    const out = await setPassphrase({ store: s, cost: 4 }, "a long enough passphrase");
    expect(out.endedSessions).toBe(1);
    expect(s.data.machines.passphrase?.hash).toMatch(/^\$2[aby]\$04\$/);
    expect(s.data.machines.generation).toBe(1);
    expect(sessions.authenticate(cookie(a.secret), "1")).toBeNull();
    expect(JSON.stringify(s.data)).not.toContain("a long enough passphrase");
  });

  it("is cleared, with every machines session, when machines are turned off", async () => {
    const s = await store();
    const sessions = new MachinesSessions(s);
    await setPassphrase({ store: s, cost: 4 }, "a long enough passphrase");
    const a = await sessions.create({ ip: "1", userAgent: "" });
    expect(await clearMachines(s)).toEqual({ endedSessions: 1 });
    expect(s.data.machines.passphrase).toBeNull();
    expect(sessions.authenticate(cookie(a.secret), "1")).toBeNull();
  });
});

describe("the machines origin's rules", () => {
  const ORIGIN = "https://machines.example.com";
  const req = (method: string, headers: IncomingHttpHeaders) => ({ method, headers }) as IncomingMessage;

  it("sends the strict header set, and no CORS at all", () => {
    const h = Object.fromEntries(MACHINES_HEADERS.map(([n, v]) => [n.toLowerCase(), v]));
    expect(h).toEqual({
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": "frame-ancestors 'none'",
      "cross-origin-opener-policy": "same-origin",
      "origin-agent-cluster": "?1",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
  });

  it("lets a GET or HEAD through from anywhere", () => {
    expect(machinesRequestRefusal(req("GET", {}), ORIGIN, false)).toBeNull();
    expect(machinesRequestRefusal(req("HEAD", { origin: "https://evil.example" }), ORIGIN, false)).toBeNull();
  });

  it("takes anything else only from exactly the machines origin", () => {
    expect(machinesRequestRefusal(req("POST", { origin: ORIGIN, "sec-fetch-site": "same-origin" }), ORIGIN, false)).toBeNull();
    expect(machinesRequestRefusal(req("POST", { origin: ORIGIN }), ORIGIN, false)).toBeNull();
    for (const headers of [
      {},
      { origin: "null" },
      { origin: "null", "sec-fetch-site": "same-origin" },
      { origin: "https://work.example.com" },
      { origin: "https://work.example.com", "sec-fetch-site": "same-site" },
      { origin: "http://machines.example.com" },
      { origin: "https://machines.example.com:8443" },
      { origin: "https://MACHINES.example.com.evil" },
      { origin: ORIGIN, "sec-fetch-site": "same-site" },
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
    ] as IncomingHttpHeaders[]) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
        expect(machinesRequestRefusal(req(method, headers), ORIGIN, false)?.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
  });

  it("holds a WebSocket handshake to the same rule, GET though it is", () => {
    expect(machinesRequestRefusal(req("GET", { origin: ORIGIN }), ORIGIN, true)).toBeNull();
    expect(machinesRequestRefusal(req("GET", {}), ORIGIN, true)?.status).toBe(403);
    expect(machinesRequestRefusal(req("GET", { origin: "https://work.example.com" }), ORIGIN, true)?.status).toBe(403);
  });

  it("refuses a service worker's script", () => {
    expect(machinesRequestRefusal(req("GET", { "service-worker": "script" }), ORIGIN, false)?.status).toBe(403);
  });
});
