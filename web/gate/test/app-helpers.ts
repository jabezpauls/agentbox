import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";
import { request, type Harness } from "./helpers.js";

/**
 * A stand-in for the bridge's data plane: `/app/<port>/…` answered by a small
 * app, the same for every port, so a test can see what crossed the gate and
 * what the gate made of the answer.
 */
export interface FakePlane {
  port: number;
  seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  /** Streams held open (event streams), to see them cut. */
  streams: Set<http.ServerResponse>;
  close(): Promise<void>;
}

const BOMB = zlib.gzipSync(Buffer.alloc(256 * 1024 * 1024, 0x20), { level: 9 });

export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/vite.svg"><script type="module" src="/@vite/client"></script></head><body><img src="/logo.png"><script type="module" src="/src/main.tsx"></script></body></html>`;

export async function startPlane(): Promise<FakePlane> {
  const seen: FakePlane["seen"] = [];
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const m = /^\/app\/(\d+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
    const rest = m?.[2] ?? "/";
    req.resume();
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    if (rest === "/" || rest.endsWith("/index.html")) return send(200, "text/html; charset=utf-8", PAGE, { etag: '"page-1"' });
    if (rest.endsWith("/gz.html")) return send(200, "text/html", zlib.gzipSync(PAGE), { "content-encoding": "gzip" });
    // A few KiB of gzip that says 256 MiB.
    if (rest.endsWith("/bomb.html")) return send(200, "text/html", BOMB, { "content-encoding": "gzip" });
    if (rest.endsWith("/own-map.html")) {
      return send(200, "text/html", `<head><script type="importmap">{"imports":{}}</script></head><body>x</body>`);
    }
    if (rest.endsWith("/style.css")) return send(200, "text/css", "body{background:url(/bg.png)}");
    if (rest.endsWith("/font.woff2")) return send(200, "font/woff2", Buffer.from("wOF2fake"));
    if (rest.endsWith("/notfont.woff2")) return send(200, "text/html", "<p>not a font</p>");
    if (rest.endsWith("/login")) {
      return send(302, "text/plain", "", {
        location: "/dashboard",
        "set-cookie": ["sid=s3cret; Path=/; Domain=localhost; HttpOnly; SameSite=Lax", "__Host-agentbox=planted; Path=/"],
      });
    }
    if (rest.endsWith("/away")) return send(302, "text/plain", "", { location: `http://localhost:${m?.[1]}/landed` });
    if (rest.endsWith("/hostile")) {
      return send(200, "application/json", "{}", {
        "clear-site-data": '"*"',
        "strict-transport-security": "max-age=31536000",
        "service-worker-allowed": "/",
      });
    }
    if (rest.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    return send(200, "application/json", JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ method: "UPGRADE", url: req.url ?? "", headers: req.headers });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ url: req.url, headers: req.headers }));
      ws.on("message", (d) => ws.send(d.toString()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    streams,
    close: () =>
      new Promise((r) => {
        wss.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Register an app through the sandbox-side API, as an agent would. */
export async function registerApp(h: Harness, body: Record<string, unknown>): Promise<{ id: string; [k: string]: unknown }> {
  const res = await request(h.apps, "POST", "/apps", { body });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${res.body}`);
  return res.json();
}

export const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html" };

/** The grant cookie pair a response set, if it set one. */
export function grantFrom(res: { headers: http.IncomingHttpHeaders }): string | null {
  const set = (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Secure-agentbox-app="));
  return set ? (set.split(";")[0] as string) : null;
}
