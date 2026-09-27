import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
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

let app: FastifyInstance;
let bridgePort: number;
let appPort: number;
let upstream: http.Server;
let dir: string;
let token: string;

/**
 * Send a request with the path exactly as written. `fetch` and `new URL` would
 * resolve dot-segments first, which is precisely the normalisation under test.
 */
function raw(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: bridgePort, path: p, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const PUBLIC = { "x-agentbox-public": "1" };

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`SHARED-APP ${req.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  appPort = (upstream.address() as AddressInfo).port;

  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "path-guard-"));
  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-guard.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-guard-static",
    WORKBENCH_SHARES_DIR: dir,
  });
  const store = new ShareStore(dir);
  app = await buildApp(config, { hub: stubHub, shares: store });
  await app.listen({ host: "127.0.0.1", port: 0 });
  bridgePort = (app.server.address() as AddressInfo).port;
  token = (await store.create(appPort)).token;
});

afterAll(async () => {
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("the public-branch header", () => {
  it("lets a clean share path through", async () => {
    const res = await raw(`/s/${token}/page?x=1`, PUBLIC);
    expect(res.status).toBe(200);
    expect(res.body).toBe("SHARED-APP /page?x=1");
  });

  it("refuses every non-share path with a 404, uniform with an unknown token", async () => {
    for (const p of [
      "/api/health",
      `/preview/${appPort}/`,
      "/api/preview/shares",
      "/",
      `/s/${token.slice(0, 31)}/`,
      `/s/${token.toUpperCase()}/`,
    ]) {
      const res = await raw(p, PUBLIC);
      expect(res.status, p).toBe(404);
      expect(res.body, p).not.toContain("herdr");
    }
  });

  // The reviewer's variants: shapes Caddy's cleaned `path` matcher reads as
  // `/s/…` while the router, on the raw string, reads as something else.
  const bypasses = [
    `/preview/${appPort}/../../../s/${token}/`,
    `/api/health/..%2f..%2f..%2fs/${token}/`,
    `/preview/${appPort}/%2e%2e/%2e%2e/%2e%2e/s/${token}/`,
    `/api/health%2f..%2f..%2fs%2f${token}/`,
    `/api/health%5c..%5cs/${token}/`,
    `//api/health/../../s/${token}/`,
    `/./api/health/../../s/${token}/`,
  ];

  for (const p of bypasses) {
    it(`does not route a marked request for ${p} anywhere private`, async () => {
      const res = await raw(p, PUBLIC);
      expect([400, 404]).toContain(res.status);
      expect(res.body).not.toContain("herdr");
      expect(res.body).not.toContain("SHARED-APP");
    });
  }

  it("refuses a marked websocket upgrade to a private route", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/events`, {
      origin: `http://127.0.0.1:${bridgePort}`,
      headers: PUBLIC,
    });
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (req, res) => {
        res.resume();
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
      ws.once("open", () => resolve(101));
      ws.once("error", () => resolve(-1));
    });
    ws.terminate();
    expect(status).toBe(404);
  });
});

describe("the raw-path guard", () => {
  const ambiguous = [
    "/api/../api/health",
    "/./api/health",
    "/api/%2e%2e/api/health",
    "/api%2fhealth",
    "/api%5chealth",
    "/api\\health",
    "/api;x/health",
    "//api/health",
    `/preview/..%2f${appPort}/`,
    `/s/${token};x/`,
    `/s//${token}/`,
  ];
  for (const p of ambiguous) {
    it(`refuses ${p} with a 400`, async () => {
      const res = await raw(p);
      expect(res.status).toBe(400);
    });
  }

  it("leaves a normal API path alone", async () => {
    expect((await raw("/api/health")).status).toBe(200);
  });

  it("forwards an app's own encoded path past the preview prefix untouched", async () => {
    const res = await raw(`/preview/${appPort}/files/a%2Fb;v=1`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("SHARED-APP /files/a%2Fb;v=1");
  });

  it("forwards an app's own encoded path past the share prefix untouched", async () => {
    const res = await raw(`/s/${token}/files/a%2Fb`, PUBLIC);
    expect(res.status).toBe(200);
    expect(res.body).toBe("SHARED-APP /files/a%2Fb");
  });

  it("ignores the query string", async () => {
    const res = await raw("/api/fs/dirs?path=a%2F..%2Fb");
    expect(res.status).not.toBe(400);
  });

  it("leaves a WebDAV path's filename characters to the DAV handler", async () => {
    // `;` and an encoded backslash are characters a filename may hold; the
    // handler reads each segment itself and 404s these missing files.
    for (const p of ["/api/dav/a;b", "/api/dav/a%5Cb", "/api/dav/a%5cb%3B"]) {
      expect((await raw(p)).status, p).toBe(404);
    }
    // What would climb out is refused there instead.
    for (const p of ["/api/dav/..%2f..%2fapi/health", "/api/dav/%2e%2e/api/health", "/api/dav/../api/health"]) {
      expect((await raw(p)).status, p).toBe(400);
    }
  });

  it("still guards a path that only resembles the DAV prefix", async () => {
    expect((await raw("/api/davx;y")).status).toBe(400);
  });
});
