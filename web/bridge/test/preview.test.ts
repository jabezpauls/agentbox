import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";

// Preview proxying needs no herdr; a stub hub keeps the other routes registrable.
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
let config: Config;
let bridgePort: number;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(req.url);
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const uaddr = upstream.address();
  upstreamPort = typeof uaddr === "object" && uaddr ? uaddr.port : 0;

  config = loadConfig({
    WORKBENCH_PORT: "0",
    WORKBENCH_BASE_PATH: "/workbench",
    HERDR_SOCKET_PATH: "/does/not/exist-preview.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-preview-static",
  });
  app = await buildApp(config, { hub: stubHub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  bridgePort = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("preview proxy", () => {
  it("redirects the bare port to the slash form", async () => {
    const res = await app.inject({ method: "GET", url: `/workbench/preview/${upstreamPort}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/workbench/preview/${upstreamPort}/`);
  });

  it("forwards the path and query with the port prefix stripped", async () => {
    const res = await fetch(
      `http://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/a/b?x=1`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/a/b?x=1");
  });

  it("proxies the root path", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/`);
    expect(await res.text()).toBe("/");
  });

  it("echoes a websocket message through the proxy", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/socket`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.once("message", (raw) => resolve(raw.toString()));
      ws.once("error", reject);
      ws.send("hello");
    });
    expect(echoed).toBe("hello");
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("rejects an out-of-range port with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/workbench/preview/70000/" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects the bridge's own port with 400", async () => {
    const res = await app.inject({ method: "GET", url: `/workbench/preview/${bridgePort}/` });
    expect(res.statusCode).toBe(400);
  });
});
