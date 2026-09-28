import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { appRequestHeaders, createDataPlane, parseAppTarget, setDataPlaneTimeouts } from "../src/data-plane.js";

/** A page load, as a browser sends it for a frame or a top-level document. */
const NAV = { "sec-fetch-dest": "iframe", accept: "text/html,*/*" };
/** A script's fetch. */
const XHR = { "sec-fetch-dest": "empty", accept: "application/json" };

let plane: http.Server;
let planePort: number;
let closedPort: number;
let refused: Set<number>;
const servers: http.Server[] = [];
let tmp: string;
let herdrSock: string;
let herdrServer: net.Server;

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

const url = (port: number, p = "/"): string => `http://127.0.0.1:${planePort}/app/${port}${p}`;

beforeAll(async () => {
  closedPort = await freePort();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plane-"));
  herdrSock = path.join(tmp, "h.sock");
  // A stand-in for herdr's socket: it answers a line with the line, upper-cased.
  herdrServer = net.createServer((c) => c.on("data", (d) => c.write(d.toString().toUpperCase())));
  await new Promise<void>((r) => herdrServer.listen(herdrSock, r));
  refused = new Set();
  plane = createDataPlane({ refusedAppPorts: () => refused, herdrSocket: herdrSock });
  await new Promise<void>((r) => plane.listen(0, "127.0.0.1", r));
  planePort = (plane.address() as AddressInfo).port;
  refused.add(planePort);
});

afterAll(async () => {
  setDataPlaneTimeouts({ connectMs: 10_000, firstByteMs: 90_000 });
  plane.closeAllConnections();
  await new Promise<void>((r) => plane.close(() => r()));
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await new Promise<void>((r) => herdrServer.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the data plane's paths", () => {
  it("reads the port and keeps the rest exactly as sent", () => {
    expect(parseAppTarget("/app/5173/src/a%2Fb;v=1?x=%2F")).toEqual({ port: 5173, path: "/src/a%2Fb;v=1?x=%2F" });
    expect(parseAppTarget("/app/5173")).toEqual({ port: 5173, path: "/" });
    expect(parseAppTarget("/app/5173?x=1")).toEqual({ port: 5173, path: "/?x=1" });
    expect(parseAppTarget("/app/5173/../7800/x")).toEqual({ port: 5173, path: "/../7800/x" });
    for (const u of ["/app/0/", "/app/70000/", "/app/51x/", "/apps/1/", "/api/health", "/app//1/"]) expect(parseAppTarget(u), u).toBeNull();
  });

  it("serves nothing else, and never one of agentbox's own ports", async () => {
    expect((await fetch(`http://127.0.0.1:${planePort}/api/health`)).status).toBe(404);
    expect((await fetch(url(planePort))).status).toBe(403);
  });
});

describe("making a request local", () => {
  it("names the app's own loopback in Host, Origin and Referer", () => {
    const out = appRequestHeaders(
      {
        host: "box.example",
        origin: "null",
        referer: "https://box.example/a/abc/page?x=1",
        "x-agentbox-prefix": "/a/abc",
        "x-agentbox-keep-prefix": "0",
        "x-forwarded-host": "box.example",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.9",
        "sec-fetch-site": "cross-site",
        cookie: "sid=1",
        connection: "keep-alive",
      },
      5173,
    );
    expect(out).toMatchObject({
      host: "127.0.0.1:5173",
      origin: "http://127.0.0.1:5173",
      referer: "http://127.0.0.1:5173/page?x=1",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.9",
      cookie: "sid=1",
    });
    for (const h of ["x-agentbox-prefix", "x-agentbox-keep-prefix", "x-forwarded-host", "x-forwarded-proto", "connection"]) {
      expect(out[h], h).toBeUndefined();
    }
  });

  it("keeps the prefix for an app started with it, and drops a referer from elsewhere", () => {
    const kept = appRequestHeaders({ referer: "https://box/a/abc/x", "x-agentbox-prefix": "/a/abc", "x-agentbox-keep-prefix": "1" }, 1);
    expect(kept.referer).toBe("http://127.0.0.1:1/a/abc/x");
    expect(appRequestHeaders({ referer: "https://box/workbench", "x-agentbox-prefix": "/a/abc" }, 1).referer).toBeUndefined();
    expect(appRequestHeaders({ referer: "https://other.example/", "x-agentbox-prefix": "/a/abc" }, 1).referer).toBeUndefined();
  });

  it("is what the app sees", async () => {
    const port = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, headers: req.headers }));
    });
    const res = await fetch(url(port, "/x%2Fy;z?q=1"), { headers: { origin: "null", "x-agentbox-prefix": "/a/abc", cookie: "app=1" } });
    const body = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(body.url).toBe("/x%2Fy;z?q=1");
    expect(body.headers.host).toBe(`127.0.0.1:${port}`);
    expect(body.headers.origin).toBe(`http://127.0.0.1:${port}`);
    expect(body.headers.cookie).toBe("app=1");
  });
});

describe("an app on either loopback", () => {
  it("is reached on ::1 when that is all it bound (a dev server told `localhost`)", async () => {
    const srv = http.createServer((_req, res) => res.end("from ::1"));
    const bound = await new Promise<boolean>((resolve) => {
      srv.once("error", () => resolve(false));
      srv.listen(0, "::1", () => resolve(true));
    });
    if (!bound) return; // no IPv6 loopback on this machine
    servers.push(srv);
    const port = (srv.address() as AddressInfo).port;
    const res = await fetch(url(port, "/"));
    expect(await res.text()).toBe("from ::1");
  });
});

describe("when nothing answers", () => {
  it("a page load gets the branded page", async () => {
    const res = await fetch(url(closedPort), { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    const body = await res.text();
    expect(body).toContain(`Nothing is serving on port ${closedPort}`);
    expect(body).toContain("Retry");
  });

  it("a missing Sec-Fetch-Dest with an HTML Accept counts as a page load", async () => {
    const res = await fetch(url(closedPort), { headers: { accept: "text/html" } });
    expect(await res.text()).toContain("Nothing is serving");
  });

  it("a script's request gets a marked 502, not a page", async () => {
    const res = await fetch(url(closedPort, "/api/data"), { method: "POST", headers: XHR, body: "{}" });
    expect(res.status).toBe(502);
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("a HEAD probe is marked without a body", async () => {
    const res = await fetch(url(closedPort), { method: "HEAD", headers: XHR });
    expect(res.headers.get("x-preview-upstream")).toBe("down");
    expect(await res.text()).toBe("");
  });

  it("an upstream that never starts its answer is given up on", async () => {
    setDataPlaneTimeouts({ firstByteMs: 150 });
    try {
      const port = await serve(() => {
        // Accept the request and never answer.
      });
      const res = await fetch(url(port), { headers: NAV });
      expect(res.headers.get("x-preview-upstream")).toBe("down");
    } finally {
      setDataPlaneTimeouts({ firstByteMs: 90_000 });
    }
  });
});

describe("what the app sends", () => {
  it("passes its own errors through, for a page load and a fetch", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain", "retry-after": "5" });
      res.end("app is warming up");
    });
    for (const headers of [NAV, XHR]) {
      const res = await fetch(url(port), { headers });
      expect(res.status).toBe(503);
      expect(res.headers.get("x-preview-upstream")).toBeNull();
      expect(await res.text()).toBe("app is warming up");
    }
  });

  it("never times out a stream once it has started", async () => {
    setDataPlaneTimeouts({ firstByteMs: 150 });
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
      expect(await res.text()).toContain("data: 4");
    } finally {
      setDataPlaneTimeouts({ firstByteMs: 90_000 });
    }
  });

  it("streams a large body with back-pressure rather than holding it", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 97);
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const pump = (): void => {
        while (sent < 32) {
          sent += 1;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    const res = await fetch(url(port, "/big"));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(32 * chunk.length);
  });
});

describe("an app's WebSocket", () => {
  it("is made local and spliced through", async () => {
    const srv = http.createServer();
    const wss = new WebSocketServer({ server: srv });
    wss.on("connection", (ws, req) => {
      ws.send(JSON.stringify({ origin: req.headers.origin, host: req.headers.host, url: req.url, protocol: ws.protocol }));
      ws.on("message", (d) => ws.send(`echo:${d.toString()}`));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    servers.push(srv);
    const port = (srv.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${planePort}/app/${port}/?token=t`, ["vite-hmr"], { headers: { origin: "null" } });
    const first = await new Promise<Record<string, string>>((resolve, reject) => {
      ws.once("message", (m) => resolve(JSON.parse(m.toString()) as Record<string, string>));
      ws.once("error", reject);
    });
    expect(first).toEqual({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, url: "/?token=t", protocol: "vite-hmr" });
    ws.send("hi");
    expect(await new Promise((r) => ws.once("message", (m) => r(m.toString())))).toBe("echo:hi");
    ws.close();
  });
});

describe("tunnels", () => {
  function open(p: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${planePort}${p}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  it("carry raw bytes to a TCP port and back, in binary frames", async () => {
    const echo = net.createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const port = (echo.address() as AddressInfo).port;
    const ws = await open(`/tunnel/tcp/${port}`);
    const back = new Promise<{ data: Buffer; binary: boolean }>((r) => ws.once("message", (data, binary) => r({ data: data as Buffer, binary })));
    ws.send(Buffer.from([0, 1, 2, 255]));
    const got = await back;
    expect(got.binary).toBe(true);
    expect([...got.data]).toEqual([0, 1, 2, 255]);
    ws.close();
    await new Promise<void>((r) => echo.close(() => r()));
  });

  it("reach herdr's socket", async () => {
    const ws = await open("/tunnel/herdr");
    const back = new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    ws.send(Buffer.from("ping\n"));
    expect(await back).toBe("PING\n");
    ws.close();
  });

  it("say why in a text frame, then close, when the far end is not there", async () => {
    const ws = await open(`/tunnel/tcp/${closedPort}`);
    const msg = await new Promise<{ text: string; binary: boolean }>((r) => ws.once("message", (d, binary) => r({ text: d.toString(), binary })));
    expect(msg.binary).toBe(false);
    expect(JSON.parse(msg.text)).toMatchObject({ type: "error", message: expect.stringContaining(`port ${closedPort}`) });
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(1011);
  });

  it("reach agentbox's own ports too: the token holder is the owner", async () => {
    const ws = await open(`/tunnel/tcp/${planePort}`);
    ws.close();
  });
});
