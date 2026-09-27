import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { ShareStore } from "../src/share/store.js";
import { SHARE_SANDBOX_CSP } from "../src/routes/proxy-core.js";
import type { SessionHub } from "../src/herdr/session.js";

const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

let upstream: http.Server;
let upstreamPort: number;
let app: FastifyInstance;
let store: ShareStore;
let config: Config;
let bridgePort: number;
let dir: string;
const streamClosed: { resolve: (() => void) | null } = { resolve: null };

async function mint(port: number): Promise<{ id: string; token: string; url: string }> {
  const res = await app.inject({ method: "POST", url: "/api/preview/shares", payload: { port } });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; token: string; url: string };
}

async function revoke(id: string): Promise<void> {
  const res = await app.inject({ method: "DELETE", url: `/api/preview/shares/${id}` });
  expect(res.statusCode).toBe(204);
}

function openWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/s/${token}/socket`, {
    origin: `http://127.0.0.1:${bridgePort}`,
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function closed(ws: WebSocket, withinMs: number): Promise<number> {
  return Promise.race([
    new Promise<number>((resolve) => ws.once("close", (code) => resolve(code))),
    new Promise<number>((_r, reject) => setTimeout(reject, withinMs, new Error("socket stayed open"))),
  ]);
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/headers")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (url.startsWith("/csp")) {
      res.writeHead(200, { "content-security-policy": "default-src 'self'", "service-worker-allowed": "/" });
      res.end("ok");
      return;
    }
    if (url.startsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tick = setInterval(() => res.write("data: x\n\n"), 30);
      res.on("close", () => {
        clearInterval(tick);
        streamClosed.resolve?.();
      });
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.end(url);
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => ws.on("message", (d, isBinary) => ws.send(d, { binary: isBinary })));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const uaddr = upstream.address();
  upstreamPort = typeof uaddr === "object" && uaddr ? uaddr.port : 0;

  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "share-routes-"));
  config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-share.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-share-static",
    WORKBENCH_SHARES_DIR: dir,
  });
  store = new ShareStore(dir);
  app = await buildApp(config, { hub: stubHub, shares: store, shareSweepMs: 40 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  bridgePort = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("public share route", () => {
  it("serves the mapped port under /s/<token> with no credentials", async () => {
    const { token } = await mint(upstreamPort);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${token}/a/b?x=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/a/b?x=1");
  });

  it("builds the public URL at the root, not under the app", async () => {
    const share = await mint(upstreamPort);
    expect(share.url).toMatch(new RegExp(`^http://.+/s/${share.token}/$`));
    expect(share.url).not.toContain("/workbench/");
  });

  it("lists the same absolute URL it minted", async () => {
    const share = await mint(upstreamPort);
    const res = await app.inject({
      method: "GET",
      url: "/api/preview/shares",
      headers: { host: `127.0.0.1:${bridgePort}` },
    });
    const listed = (res.json() as { token: string; url: string }[]).find((s) => s.token === share.token);
    expect(listed?.url).toBe(`http://127.0.0.1:${bridgePort}/s/${share.token}/`);
  });

  it("returns the live share when a port is shared again, rather than a second link", async () => {
    const first = await mint(upstreamPort);
    const again = await mint(upstreamPort);
    expect(again.token).toBe(first.token);
    expect(again.id).toBe(first.id);
  });

  it("redirects the bare token to the slash form", async () => {
    const { token } = await mint(upstreamPort);
    const res = await app.inject({ method: "GET", url: `/s/${token}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/s/${token}/`);
  });

  it("404s an unknown token without revealing anything", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${"0".repeat(32)}/`);
    expect(res.status).toBe(404);
  });

  it("404s immediately after revoke", async () => {
    const { id, token } = await mint(upstreamPort);
    await revoke(id);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${token}/`);
    expect(res.status).toBe(404);
  });

  it("404s through the route once a share has expired", async () => {
    // Clear the port's live share, then mint one with a 1ms life.
    await revoke((await mint(upstreamPort)).id);
    const share = await store.create(upstreamPort, 1);
    await new Promise((r) => setTimeout(r, 20));
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${share.token}/`);
    expect(res.status).toBe(404);
  });

  it("does not forward Authorization or Cookie to the shared upstream", async () => {
    const { token } = await mint(upstreamPort);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${token}/headers`, {
      headers: { authorization: "Basic x", cookie: "s=secret", "x-keep-me": "yes" },
    });
    const headers = (await res.json()) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-keep-me"]).toBe("yes");
  });

  it("echoes a websocket through the shared token", async () => {
    const { token } = await mint(upstreamPort);
    const ws = await openWs(token);
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.once("message", (raw) => resolve(raw.toString()));
      ws.once("error", reject);
      ws.send("hi");
    });
    expect(echoed).toBe("hi");
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("rejects an out-of-range port at mint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/preview/shares",
      payload: { port: 70000 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("infrastructure ports", () => {
  it("refuses to mint a share for agentbox's own services or the bridge", async () => {
    for (const port of [8080, 7681, 7682, 7683, bridgePort]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/preview/shares",
        payload: { port },
      });
      expect(res.statusCode, `port ${port}`).toBe(400);
    }
  });

  it("refuses to serve a share that maps to an infrastructure port", async () => {
    // A record written before the rule existed, or by hand, must still 404.
    const share = await store.create(7681);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${share.token}/`);
    expect(res.status).toBe(404);
  });
});

describe("the shared page's origin", () => {
  it("serves every shared response under a CSP sandbox, alongside the app's own policy", async () => {
    const { token } = await mint(upstreamPort);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${token}/csp`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(SHARE_SANDBOX_CSP);
    expect(csp).toContain("default-src 'self'");
    expect(res.headers.get("service-worker-allowed")).toBeNull();
  });

  it("does not sandbox the owner's private preview", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/preview/${upstreamPort}/csp`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});

describe("ending a share cuts open connections", () => {
  it("closes an open websocket on revoke", async () => {
    const { id, token } = await mint(upstreamPort);
    const ws = await openWs(token);
    const done = closed(ws, 1500);
    await revoke(id);
    expect(await done).toBe(1008);
  });

  it("cuts an open stream on revoke", async () => {
    const { id, token } = await mint(upstreamPort);
    const upstreamGone = new Promise<void>((resolve) => {
      streamClosed.resolve = resolve;
    });
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${token}/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    await revoke(id);
    // The viewer's stream ends (or errors) and the upstream sees the abort.
    const ended = (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      } catch {
        return;
      }
    })();
    await Promise.race([
      Promise.all([ended, upstreamGone]),
      new Promise((_r, reject) => setTimeout(reject, 1500, new Error("stream stayed open"))),
    ]);
    streamClosed.resolve = null;
  });

  it("closes an open websocket once the share expires", async () => {
    const existing = await mint(upstreamPort);
    await revoke(existing.id);
    const share = await store.create(upstreamPort, 250);
    const ws = await openWs(share.token);
    // The sweep (every 40ms here) notices the expiry and closes the socket.
    expect(await closed(ws, 1500)).toBe(1008);
  });
});

describe("sharing disabled", () => {
  let offApp: FastifyInstance;
  let offDir: string;

  beforeAll(async () => {
    offDir = await fsp.mkdtemp(path.join(os.tmpdir(), "share-off-"));
    const offConfig = loadConfig({
      WORKBENCH_PORT: "0",
      HERDR_SOCKET_PATH: "/does/not/exist-shareoff.sock",
      WORKBENCH_STATIC_DIR: "/does/not/exist-shareoff-static",
      WORKBENCH_SHARES_DIR: offDir,
      WORKBENCH_PREVIEW_MODE: "off",
    });
    offApp = await buildApp(offConfig, { hub: stubHub });
    await offApp.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => {
    await offApp.close();
    await fsp.rm(offDir, { recursive: true, force: true });
  });

  it("refuses to mint and 404s every token when sharing is off", async () => {
    const mintRes = await offApp.inject({
      method: "POST",
      url: "/api/preview/shares",
      payload: { port: 3000 },
    });
    expect(mintRes.statusCode).toBe(403);
    const serveRes = await offApp.inject({ method: "GET", url: `/s/${"a".repeat(32)}/` });
    expect(serveRes.statusCode).toBe(404);
  });
});
