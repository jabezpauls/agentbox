import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { ClientOptions } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";
import type { TerminalStreams } from "../src/herdr/terminal.js";

// The origin check runs before any handler, so neither herdr nor a real
// terminal stream is needed: stubs keep the routes registrable.
const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

const stubStreams = {
  attach: () => ({
    input: () => {},
    resize: () => {},
    scroll: () => {},
    focus: () => {},
    detach: () => {},
  }),
  stop: () => {},
} as unknown as TerminalStreams;

let app: FastifyInstance;
let config: Config;
let baseUrl: string;
let upstream: http.Server;
let upstreamPort: number;

beforeAll(async () => {
  // A real upstream so the preview route's accepted case stays open rather
  // than closing on a failed connection.
  upstream = http.createServer((_req, res) => res.end("ok"));
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const uaddr = upstream.address();
  upstreamPort = typeof uaddr === "object" && uaddr ? uaddr.port : 0;

  config = loadConfig({
    WORKBENCH_PORT: "0",
    WORKBENCH_BASE_PATH: "/workbench",
    HERDR_SOCKET_PATH: "/does/not/exist-ws-origin.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-ws-origin-static",
  });
  app = await buildApp(config, { hub: stubHub, streams: stubStreams });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  baseUrl = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** Resolves with the handshake status when the upgrade is refused. */
function refusedStatus(path: string, options: ClientOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}${path}`, options);
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("upgrade was accepted"));
    });
    ws.once("error", (err) => reject(err));
  });
}

/** Resolves once the upgrade is accepted (the handler may close afterwards). */
function accepted(path: string, options: ClientOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}${path}`, options);
    ws.once("open", () => {
      ws.close();
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      reject(new Error(`upgrade refused with ${res.statusCode}`));
    });
    ws.once("error", (err) => reject(err));
  });
}

const EVENTS = "/workbench/ws/events";
const TERMINAL = "/workbench/ws/terminal?pane=w1:p1";

describe("websocket origin checks", () => {
  // The preview port is only known once the upstream is listening, so each
  // route names its path lazily.
  const ROUTES: { name: string; path(): string }[] = [
    { name: "events", path: () => EVENTS },
    { name: "terminal", path: () => TERMINAL },
    { name: "preview", path: () => `/workbench/preview/${upstreamPort}/socket` },
  ];

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("accepts a same-origin upgrade", async () => {
        await expect(accepted(route.path(), { origin: `http://${baseUrl}` })).resolves.toBeUndefined();
      });

      it("rejects a foreign origin", async () => {
        await expect(refusedStatus(route.path(), { origin: "http://evil.example" })).resolves.toBe(403);
      });

      it("rejects Origin: null", async () => {
        await expect(refusedStatus(route.path(), { origin: "null" })).resolves.toBe(403);
      });

      it("rejects a missing Origin", async () => {
        await expect(refusedStatus(route.path(), {})).resolves.toBe(403);
      });
    });
  }

  it("accepts an https origin when the proxy forwards that scheme", async () => {
    await expect(
      accepted(EVENTS, {
        origin: `https://${baseUrl}`,
        headers: { "x-forwarded-proto": "https" },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an origin whose scheme contradicts the forwarded one", async () => {
    await expect(
      refusedStatus(EVENTS, {
        origin: `http://${baseUrl}`,
        headers: { "x-forwarded-proto": "https" },
      }),
    ).resolves.toBe(403);
  });

  it("rejects an origin that only looks like this host", async () => {
    await expect(refusedStatus(EVENTS, { origin: `http://${baseUrl}.evil.example` })).resolves.toBe(
      403,
    );
  });

  it("leaves plain HTTP requests on the preview route alone", async () => {
    // No Origin and no upgrade: the hook must let the request through to the
    // handler, which is what answers 400 for an out-of-range port.
    const res = await app.inject({ method: "GET", url: "/workbench/preview/70000/" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid preview port" });
  });
});
