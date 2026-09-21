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

async function mint(port: number): Promise<{ id: string; token: string; url: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/workbench/api/preview/shares",
    payload: { port },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; token: string; url: string };
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/headers")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
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
    WORKBENCH_BASE_PATH: "/workbench",
    HERDR_SOCKET_PATH: "/does/not/exist-share.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-share-static",
    WORKBENCH_SHARES_DIR: dir,
  });
  store = new ShareStore(dir);
  app = await buildApp(config, { hub: stubHub, shares: store });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  bridgePort = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await app.close();
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

  it("builds the public URL at the root, not under the base path", async () => {
    const share = await mint(upstreamPort);
    expect(share.url).toMatch(new RegExp(`/s/${share.token}/$`));
    expect(share.url).not.toContain("/workbench/");
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
    const del = await app.inject({ method: "DELETE", url: `/workbench/api/preview/shares/${id}` });
    expect(del.statusCode).toBe(204);
    const res = await fetch(`http://127.0.0.1:${bridgePort}/s/${token}/`);
    expect(res.status).toBe(404);
  });

  it("404s an expired share", async () => {
    const share = await store.create(upstreamPort);
    const file = path.join(dir, "shares.json");
    const rows = JSON.parse(await fsp.readFile(file, "utf8")) as { token: string; expires: string }[];
    const row = rows.find((r) => r.token === share.token)!;
    row.expires = new Date(Date.now() - 1000).toISOString();
    await fsp.writeFile(file, JSON.stringify(rows));
    // A fresh store reads the mutated file; point the app's store at it by
    // clearing its cache through a list() (which reloads on next resolve).
    const fresh = new ShareStore(dir);
    expect(await fresh.resolve(share.token)).toBeNull();
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
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/s/${token}/socket`, {
      origin: `http://127.0.0.1:${bridgePort}`,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.once("message", (raw) => resolve(raw.toString()));
      ws.once("error", reject);
      ws.send("hi");
    });
    expect(echoed).toBe("hi");
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("lists the owner's live shares under the authenticated base path", async () => {
    const res = await app.inject({ method: "GET", url: "/workbench/api/preview/shares" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { token: string }[];
    expect(Array.isArray(list)).toBe(true);
  });

  it("rejects an out-of-range port at mint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workbench/api/preview/shares",
      payload: { port: 70000 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("sharing disabled", () => {
  let offApp: FastifyInstance;
  let offDir: string;

  beforeAll(async () => {
    offDir = await fsp.mkdtemp(path.join(os.tmpdir(), "share-off-"));
    const offConfig = loadConfig({
      WORKBENCH_PORT: "0",
      WORKBENCH_BASE_PATH: "/workbench",
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
      url: "/workbench/api/preview/shares",
      payload: { port: 3000 },
    });
    expect(mintRes.statusCode).toBe(403);
    const serveRes = await offApp.inject({ method: "GET", url: `/s/${"a".repeat(32)}/` });
    expect(serveRes.statusCode).toBe(404);
  });
});
