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

// Lets a test observe when the upstream saw a proxied request torn down.
const slowClose: { resolve: (() => void) | null } = { resolve: null };

let upstream: http.Server;
let upstreamPort: number;
let app: FastifyInstance;
let config: Config;
let bridgePort: number;

function rawGet(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${bridgePort}${path}`, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/slow")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x".repeat(1024));
      const timer = setInterval(() => {
        try {
          res.write("x".repeat(1024));
        } catch {
          // response gone
        }
      }, 50);
      res.on("close", () => {
        clearInterval(timer);
        slowClose.resolve?.();
      });
      return;
    }
    if (url.startsWith("/redirect")) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (url.startsWith("/absredirect")) {
      res.writeHead(302, { location: "https://example.com/x" });
      res.end();
      return;
    }
    if (url.startsWith("/headers")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (url.startsWith("/setcookie")) {
      res.writeHead(200, { "set-cookie": "a=1; Path=/" });
      res.end("ok");
      return;
    }
    if (url.startsWith("/cookiedomain")) {
      res.writeHead(200, { "set-cookie": "a=1; Path=/; Domain=example.com; HttpOnly" });
      res.end("ok");
      return;
    }
    if (url.startsWith("/cookieucase")) {
      // Cookie attribute names are case-insensitive; the rewrite must match PATH.
      res.writeHead(200, { "set-cookie": "b=2; PATH=/app" });
      res.end("ok");
      return;
    }
    if (url.startsWith("/cookiepreprefixed")) {
      const p = (req.headers.host ?? "").split(":")[1] ?? "";
      res.writeHead(200, { "set-cookie": `c=3; Path=/workbench/preview/${p}/scoped` });
      res.end("ok");
      return;
    }
    if (url.startsWith("/preprefixed")) {
      // An upstream that already honours a preview prefix must not be doubled.
      const p = (req.headers.host ?? "").split(":")[1] ?? "";
      res.writeHead(302, { location: `/workbench/preview/${p}/deep` });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.end(url);
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    if (req.url?.includes("headers")) {
      ws.send(JSON.stringify(req.headers));
      return;
    }
    if (req.url?.includes("close4001")) {
      ws.close(4001, "bye");
      return;
    }
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

  it("preserves percent-encoding in the proxied path", async () => {
    const res = await fetch(
      `http://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/a%20b?x=1`,
    );
    expect(await res.text()).toBe("/a%20b?x=1");
  });

  it("proxies the root path", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/`);
    expect(await res.text()).toBe("/");
  });

  it("echoes a websocket message through the proxy", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/socket`, {
      origin: `http://127.0.0.1:${bridgePort}`,
    });
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

  it("survives a client disconnect mid-response and aborts the upstream", async () => {
    const upstreamClosed = new Promise<void>((resolve) => {
      slowClose.resolve = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      const client = http.get(
        `http://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/slow`,
        (res) => {
          res.once("data", () => {
            client.destroy();
            resolve();
          });
        },
      );
      client.on("error", () => resolve());
      setTimeout(reject, 2000, new Error("no data from slow upstream"));
    });
    // The upstream must observe the abort promptly...
    await Promise.race([
      upstreamClosed,
      new Promise<void>((_r, reject) => setTimeout(reject, 1500, new Error("upstream not aborted"))),
    ]);
    slowClose.resolve = null;
    // ...and the bridge must keep serving.
    const health = await app.inject({ method: "GET", url: "/workbench/api/health" });
    expect(health.statusCode).toBe(200);
  });

  describe("header rewriting", () => {
    it("rewrites a root-relative Location into the preview prefix", async () => {
      const { status, headers } = await rawGet(`/workbench/preview/${upstreamPort}/redirect`);
      expect(status).toBe(302);
      expect(headers.location).toBe(`/workbench/preview/${upstreamPort}/login`);
    });

    it("leaves an absolute Location untouched", async () => {
      const { headers } = await rawGet(`/workbench/preview/${upstreamPort}/absredirect`);
      expect(headers.location).toBe("https://example.com/x");
    });

    it("prefixes a Set-Cookie Path with the preview prefix", async () => {
      const { headers } = await rawGet(`/workbench/preview/${upstreamPort}/setcookie`);
      expect(headers["set-cookie"]).toEqual([`a=1; Path=/workbench/preview/${upstreamPort}/`]);
    });

    it("does not double-prefix a Location already inside the preview prefix", async () => {
      const { headers } = await rawGet(`/workbench/preview/${upstreamPort}/preprefixed`);
      expect(headers.location).toBe(`/workbench/preview/${upstreamPort}/deep`);
    });

    it("strips a Set-Cookie Domain so it cannot widen onto the appliance host", async () => {
      const { headers } = await rawGet(`/workbench/preview/${upstreamPort}/cookiedomain`);
      const cookie = (headers["set-cookie"] as string[])[0]!;
      expect(cookie).not.toMatch(/domain=/i);
      expect(cookie).toContain(`Path=/workbench/preview/${upstreamPort}/`);
      expect(cookie).toContain("HttpOnly");
    });

    it("rewrites a case-insensitive Set-Cookie PATH attribute", async () => {
      const { headers } = await rawGet(`/workbench/preview/${upstreamPort}/cookieucase`);
      expect(headers["set-cookie"]).toEqual([`b=2; Path=/workbench/preview/${upstreamPort}/app`]);
    });

    it("does not double-prefix a Set-Cookie Path already inside the preview prefix", async () => {
      const { headers } = await rawGet(`/workbench/preview/${upstreamPort}/cookiepreprefixed`);
      expect(headers["set-cookie"]).toEqual([`c=3; Path=/workbench/preview/${upstreamPort}/scoped`]);
    });
  });

  describe("credentials", () => {
    // Caddy's basic_auth leaves Authorization on the request; forwarding it
    // would hand the appliance's plaintext login to whatever an agent started
    // on that port.
    it("does not forward Authorization or Cookie to the upstream", async () => {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/headers`, {
        headers: {
          authorization: "Basic dXNlcjpwYXNzd29yZA==",
          cookie: "session=secret",
          "x-keep-me": "yes",
        },
      });
      const headers = (await res.json()) as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers["x-keep-me"]).toBe("yes");
    });

    it("does not forward Authorization or Cookie on a websocket upgrade", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/headers`, {
        origin: `http://127.0.0.1:${bridgePort}`,
        headers: {
          authorization: "Basic dXNlcjpwYXNzd29yZA==",
          cookie: "session=secret",
          "x-keep-me": "yes",
        },
      });
      const headers = await new Promise<Record<string, string>>((resolve, reject) => {
        ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, string>));
        ws.once("error", reject);
      });
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers["x-keep-me"]).toBe("yes");
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });
  });

  describe("websocket subprotocols", () => {
    it("negotiates the client subprotocol end to end", async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/socket`,
        ["vite-hmr"],
        { origin: `http://127.0.0.1:${bridgePort}` },
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      expect(ws.protocol).toBe("vite-hmr");
      const echoed = await new Promise<string>((resolve, reject) => {
        ws.once("message", (raw) => resolve(raw.toString()));
        ws.once("error", reject);
        ws.send("ping");
      });
      expect(echoed).toBe("ping");
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    it("propagates the upstream close code to the client", async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${bridgePort}/workbench/preview/${upstreamPort}/close4001`,
        { origin: `http://127.0.0.1:${bridgePort}` },
      );
      const code = await new Promise<number>((resolve, reject) => {
        ws.once("close", (closeCode) => resolve(closeCode));
        ws.once("error", reject);
      });
      expect(code).toBe(4001);
    });
  });
});
