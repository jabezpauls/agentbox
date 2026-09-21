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
let badGateway: http.Server;
let badPort: number;
let closedPort: number;

/** Reserve a port, then free it, so nothing is listening there. */
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  badGateway = http.createServer((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("upstream is warming up");
  });
  await new Promise<void>((resolve) => badGateway.listen(0, "127.0.0.1", resolve));
  badPort = (badGateway.address() as AddressInfo).port;
  closedPort = await freePort();

  const config = loadConfig({
    WORKBENCH_PORT: "0",
    WORKBENCH_BASE_PATH: "/workbench",
    HERDR_SOCKET_PATH: "/does/not/exist-fallback.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-fallback-static",
  });
  app = await buildApp(config, { hub: stubHub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  bridgePort = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => badGateway.close(() => resolve()));
});

describe("preview fallback", () => {
  it("serves a branded 200 page, not a 5xx, when the port is refused", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${closedPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    const body = await res.text();
    expect(body).toContain(`Nothing is serving on port ${closedPort}`);
    expect(body).toContain("Retry");
  });

  it("serves the error variant, not a bare 502, on a gateway status", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${badPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    expect(await res.text()).toContain(`Port ${badPort} returned an error`);
  });

  it("marks the fallback on a HEAD probe without a body", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${closedPort}/`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    expect(await res.text()).toBe("");
  });

  it("passes a real upstream through untouched", async () => {
    const real = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from the app");
    });
    await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
    const port = (real.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-preview-upstream")).toBeNull();
      expect(await res.text()).toBe("hello from the app");
    } finally {
      await new Promise<void>((resolve) => real.close(() => resolve()));
    }
  });

  it("still passes a plain 500 through so an app's own error page shows", async () => {
    const erroring = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<h1>App error overlay</h1>");
    });
    await new Promise<void>((resolve) => erroring.listen(0, "127.0.0.1", resolve));
    const port = (erroring.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${port}/`);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("App error overlay");
    } finally {
      await new Promise<void>((resolve) => erroring.close(() => resolve()));
    }
  });
});
