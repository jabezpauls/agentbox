import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
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

beforeAll(async () => {
  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-guard.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-guard-static",
  });
  app = await buildApp(config, { hub: stubHub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  bridgePort = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
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

  it("serves no app and no share here: the old public and preview paths are gone", async () => {
    for (const p of ["/preview/3000/", "/s/0123456789abcdef0123456789abcdef/", "/api/preview/shares"]) {
      expect((await raw(p, { "x-agentbox-public": "1" })).status, p).toBe(404);
    }
  });
});
