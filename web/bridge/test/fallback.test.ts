import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setProxyTimeouts } from "../src/routes/proxy-core.js";
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

/** A page load, as a browser sends it for a frame or a top-level document. */
const NAV = { "sec-fetch-dest": "iframe", accept: "text/html,*/*" };
/** A script's fetch. */
const XHR = { "sec-fetch-dest": "empty", accept: "application/json" };

let app: FastifyInstance;
let bridgePort: number;
const servers: http.Server[] = [];
let closedPort: number;

async function serve(handler: http.RequestListener): Promise<number> {
  const srv = http.createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  servers.push(srv);
  return (srv.address() as AddressInfo).port;
}

/** Reserve a port, then free it, so nothing is listening there. */
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

const url = (port: number, path = "/"): string => `http://127.0.0.1:${bridgePort}/preview/${port}${path}`;

beforeAll(async () => {
  closedPort = await freePort();
  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-fallback.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-fallback-static",
  });
  app = await buildApp(config, { hub: stubHub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  bridgePort = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  setProxyTimeouts({ connectMs: 10_000, firstByteMs: 90_000 });
  await app.close();
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("preview fallback", () => {
  it("serves the branded page for a page load on a refused port", async () => {
    const res = await fetch(url(closedPort), { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    const body = await res.text();
    expect(body).toContain(`Nothing is serving on port ${closedPort}`);
    expect(body).toContain("Retry");
  });

  it("treats a missing Sec-Fetch-Dest with an HTML Accept as a page load", async () => {
    const res = await fetch(url(closedPort), { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing is serving");
  });

  it("answers a script's request on a refused port with a marked 502, not a page", async () => {
    const res = await fetch(url(closedPort, "/api/data"), { method: "POST", headers: XHR, body: "{}" });
    expect(res.status).toBe(502);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("marks a HEAD probe without a body", async () => {
    const res = await fetch(url(closedPort), { method: "HEAD", headers: XHR });
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    expect(await res.text()).toBe("");
  });

  it("passes an upstream's own 503 through untouched, for a page load and a fetch", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain", "retry-after": "5" });
      res.end("app is warming up");
    });
    for (const headers of [NAV, XHR]) {
      const res = await fetch(url(port), { headers });
      expect(res.status).toBe(503);
      expect(res.headers.get("x-preview-upstream")).toBeNull();
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.text()).toBe("app is warming up");
    }
  });

  it("passes a plain 500 through so an app's own error page shows", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<h1>App error overlay</h1>");
    });
    const res = await fetch(url(port), { headers: NAV });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("App error overlay");
  });

  it("passes a real upstream through untouched", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from the app");
    });
    const res = await fetch(url(port), { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-preview-upstream")).toBeNull();
    expect(await res.text()).toBe("hello from the app");
  });

  it("strips Service-Worker-Allowed from proxied responses", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "service-worker-allowed": "/", "content-type": "text/javascript" });
      res.end("self.addEventListener('fetch', () => {})");
    });
    const res = await fetch(url(port, "/sw.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("service-worker-allowed")).toBeNull();
  });

  describe("timeouts", () => {
    it("gives up on an upstream that never starts its response", async () => {
      setProxyTimeouts({ firstByteMs: 150 });
      try {
        const port = await serve(() => {
          // Accept the request and never answer.
        });
        const res = await fetch(url(port), { headers: NAV });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-preview-upstream")).toBe("down");
      } finally {
        setProxyTimeouts({ firstByteMs: 90_000 });
      }
    });

    it("never times out a stream once its response has started", async () => {
      // An SSE-style response: headers at once, then events well past the
      // first-byte window. The old socket-idle timeout cut these off.
      setProxyTimeouts({ firstByteMs: 150 });
      try {
        const port = await serve((_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          let n = 0;
          const tick = setInterval(() => {
            n += 1;
            res.write(`data: ${n}\n\n`);
            if (n === 4) {
              clearInterval(tick);
              res.end();
            }
          }, 200);
        });
        const res = await fetch(url(port, "/events"), { headers: { accept: "text/event-stream" } });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("data: 4");
      } finally {
        setProxyTimeouts({ firstByteMs: 90_000 });
      }
    });
  });
});
