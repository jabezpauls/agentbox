import http from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import net, { type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";

/**
 * The bridge's data plane: a listener of its own (:7801) that the gate alone
 * talks to, serving nothing but apps and tunnels.
 *
 *   /app/<port>/…       an app on the sandbox's loopback, requests and WebSockets
 *   /tunnel/tcp/<port>  a WebSocket of raw bytes to a loopback port (the CLI's `forward`)
 *   /tunnel/herdr       the same to herdr's socket (the CLI's `herdr socket`)
 *
 * Splitting it from the control plane (:7800, the app shell and its API)
 * makes "app content never reaches the box's origin unsandboxed" a fact of
 * routing: the gate only ever sends `/a/<id>/` here, and wraps what comes back
 * in the app policy. Nothing reached through this listener is anything a
 * process in the sandbox could not reach on its own loopback already.
 *
 * What it does for an app is make the request look local — `Host`, `Origin`
 * and `Referer` name `127.0.0.1:<port>` — so a dev server's own host and
 * origin checks (Vite's `allowedHosts` and its WebSocket origin check, Next's
 * dev origin checks) pass; and when nothing answers, a page load gets a calm
 * branded page instead of an error from the edge.
 */

// Per RFC 7230 §6.1, hop-by-hop headers are not forwarded.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * What the gate tells this plane, and what describes the box rather than the
 * app: an app sees a request to `127.0.0.1:<port>`, not to the box — the box's
 * host in `X-Forwarded-Host` is exactly what would make a framework write the
 * box's root into its URLs.
 */
const NOT_FORWARDED = new Set(["x-agentbox-prefix", "x-agentbox-keep-prefix", "x-forwarded-host", "x-forwarded-proto", "forwarded"]);

/** Connect to the app: loopback either connects at once or is refused, so this only matters for a wedged listener. */
let connectTimeoutMs = 10_000;
/**
 * The app's answer must start within this: generous, for a dev server's first
 * compile, and under Cloudflare's 100 s origin timeout so the plane answers
 * before the edge does. Once it has started there is no timeout at all: an
 * event stream or a long download is the app's business.
 */
let firstByteTimeoutMs = 90_000;

/** Shorten the windows so tests can see them; never used in production. */
export function setDataPlaneTimeouts(t: { connectMs?: number; firstByteMs?: number }): void {
  if (t.connectMs !== undefined) connectTimeoutMs = t.connectMs;
  if (t.firstByteMs !== undefined) firstByteTimeoutMs = t.firstByteMs;
}

export interface DataPlaneOptions {
  /** Ports never served as apps: the bridge's own listeners, and the gate's list besides. */
  refusedAppPorts(): Set<number>;
  /** herdr's socket, for `/tunnel/herdr`. */
  herdrSocket: string;
}

interface AppTarget {
  port: number;
  /** The path and query to request on the app, raw. */
  path: string;
}

/**
 * How the plane reaches a port on the sandbox's loopback: IPv4 first, then
 * IPv6. A dev server told to listen on `localhost` may have bound `::1` alone
 * (Node and Vite resolve it the way the system does), and it must be reached
 * all the same; nothing but these two addresses is ever tried.
 */
const LOOPBACK_ADDRESSES = [
  { address: "127.0.0.1", family: 4 },
  { address: "::1", family: 6 },
];
const lookupLoopback: LookupFunction = (_host, opts, cb) => {
  const done = cb as (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
  if (opts.all) done(null, LOOPBACK_ADDRESSES);
  else done(null, "127.0.0.1", 4);
};
export const LOOPBACK = { host: "loopback.agentbox.invalid", autoSelectFamily: true, lookup: lookupLoopback };

/** Parse `/app/<port>/…` from a raw request target; `null` for anything else. */
export function parseAppTarget(url: string): AppTarget | null {
  const m = /^\/app\/(\d{1,5})(?=[/?]|$)(.*)$/s.exec(url);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  let rest = m[2] ?? "";
  if (!rest.startsWith("/")) rest = `/${rest}`;
  return { port, path: rest };
}

/** True for a page load (a document or a frame), which may be answered with the fallback page. */
function isNavigation(req: IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string") return dest === "document" || dest === "iframe" || dest === "frame";
  return String(req.headers.accept ?? "").includes("text/html");
}

/**
 * The headers an app is sent: the gate's, less hop-by-hop headers and the
 * box's own identity, with `Host`, `Origin` and `Referer` made local.
 */
export function appRequestHeaders(headers: IncomingHttpHeaders, port: number, upgrade = false): IncomingHttpHeaders {
  const local = `127.0.0.1:${port}`;
  const prefix = typeof headers["x-agentbox-prefix"] === "string" ? headers["x-agentbox-prefix"] : null;
  const keepPrefix = headers["x-agentbox-keep-prefix"] === "1";
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if ((!upgrade && HOP_BY_HOP.has(name)) || NOT_FORWARDED.has(name)) continue;
    out[name] = value;
  }
  out.host = local;
  if (out.origin !== undefined) out.origin = `http://${local}`;
  if (typeof out.referer === "string") {
    const referer = localReferer(out.referer, local, prefix, keepPrefix);
    if (referer === null) delete out.referer;
    else out.referer = referer;
  }
  // A dev server that refuses cross-site requests for its own assets (Next
  // does) sees what it would see from its own page.
  if (out["sec-fetch-site"] !== undefined) out["sec-fetch-site"] = "same-origin";
  return out;
}

/** A referer inside the app, as the app would have seen it locally; `null` for any other. */
function localReferer(raw: string, local: string, prefix: string | null, keepPrefix: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!prefix || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return null;
  const pathname = keepPrefix ? url.pathname : url.pathname.slice(prefix.length) || "/";
  return `http://${local}${pathname}${url.search}`;
}

/**
 * The branded page for a page load that finds nothing serving. Self-contained
 * (inline CSS, the app's palette in both themes), and marked with
 * `X-Preview-Upstream: down` so the Preview panel's probe can tell it from a
 * real answer without reading it.
 */
export function fallbackPage(port: number): string {
  const title = `Nothing is serving on port ${port}`;
  const detail = "No server has answered on this port yet. If you just started one, give it a moment and retry.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root {
    --bg: #f8f9fc; --surface: #ffffff; --border: #e5e8f0; --border-strong: #d3d8e3;
    --text: #10131f; --text-2: #56607a; --accent: #2563eb; --accent-2: #1d4ed8; --on-accent: #ffffff;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e17; --surface: #151a27; --border: #262d40; --border-strong: #37405a;
      --text: #eef1f7; --text-2: #a2acc0; --accent: #2f6fed; --accent-2: #4a86f0; --on-accent: #ffffff;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--text);
    font-family: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(420px, 100%); background: var(--surface);
    border: 1px solid var(--border); border-radius: 12px;
    padding: 24px; text-align: center;
  }
  .glyph {
    width: 40px; height: 40px; margin: 0 auto 12px; border-radius: 999px;
    display: grid; place-items: center; background: var(--bg);
    border: 1px solid var(--border-strong); color: var(--text-2);
  }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 20px; color: var(--text-2); }
  button {
    font: inherit; font-weight: 500; cursor: pointer;
    padding: 8px 16px; border-radius: 8px; border: 1px solid transparent;
    background: var(--accent); color: var(--on-accent);
    transition: background 120ms ease;
  }
  button:hover { background: var(--accent-2); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
  <main class="card">
    <div class="glyph" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </div>
    <h1>${title}</h1>
    <p>${detail}</p>
    <button type="button" onclick="location.reload()">Retry</button>
  </main>
</body>
</html>`;
}

/** Nothing answered: the branded page for a page load, a marked 502 for a script. */
function upstreamDown(req: IncomingMessage, res: ServerResponse, port: number): void {
  if (res.headersSent || res.destroyed) return;
  const nav = isNavigation(req);
  const body = Buffer.from(nav ? fallbackPage(port) : JSON.stringify({ error: "nothing is serving on this port" }), "utf8");
  res.writeHead(nav ? 200 : 502, {
    "content-type": nav ? "text/html; charset=utf-8" : "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-preview-upstream": "down",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(`${text}\n`);
}

// Keep-alive to the apps: a dev server's page load is dozens of requests.
const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });

/**
 * One request to an app. Streams both ways (back-pressure is the pipes'), and
 * the answer passes through as the app sent it — error statuses included, so
 * a framework's own error page shows. Only when nothing answers before the
 * first byte does the plane answer instead.
 */
function proxyApp(req: IncomingMessage, res: ServerResponse, target: AppTarget): void {
  let started = false;
  const upReq = http.request(
    { ...LOOPBACK, port: target.port, method: req.method, path: target.path, headers: appRequestHeaders(req.headers, target.port), agent },
    (upRes) => {
      started = true;
      clearTimeout(firstByte);
      if (res.destroyed) {
        upRes.destroy();
        return;
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, headers);
      pipeline(upRes, res, () => {});
    },
  );
  const giveUp = (): void => {
    if (started) return;
    started = true;
    upstreamDown(req, res, target.port);
    upReq.destroy();
  };
  const firstByte = setTimeout(giveUp, firstByteTimeoutMs);
  firstByte.unref();
  upReq.on("socket", (sock) => {
    if (!sock.connecting) return;
    const connect = setTimeout(giveUp, connectTimeoutMs);
    connect.unref();
    sock.once("connect", () => clearTimeout(connect));
    sock.once("close", () => clearTimeout(connect));
  });
  upReq.on("error", () => {
    if (!started) {
      clearTimeout(firstByte);
      giveUp();
      return;
    }
    res.destroy();
  });
  // The gate (and so the browser) went away: so does the exchange with the app.
  res.on("close", () => {
    clearTimeout(firstByte);
    if (!res.writableFinished) upReq.destroy();
  });
  pipeline(req, upReq, () => {});
}

/** An app's WebSocket (HMR, say): the handshake made local, then the two sockets spliced. */
function proxyAppUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: AppTarget): void {
  const headers = appRequestHeaders(req.headers, target.port, true);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade ?? "websocket";
  const upReq = http.request({ ...LOOPBACK, port: target.port, method: req.method, path: target.path, headers, agent: false });
  let upgraded = false;
  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    upgraded = true;
    if (socket.destroyed) {
      upSocket.destroy();
      return;
    }
    let block = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Switching Protocols"}\r\n`;
    for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) block += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
    socket.write(`${block}\r\n`);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    const end = (): void => {
      socket.destroy();
      upSocket.destroy();
    };
    for (const s of [socket, upSocket]) {
      s.on("error", end);
      s.on("close", end);
    }
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upReq.on("response", (upRes) => {
    // The app answered without upgrading: pass its answer on, then close.
    let block = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ""}\r\n`;
    for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) {
      const name = upRes.rawHeaders[i] as string;
      if (!HOP_BY_HOP.has(name.toLowerCase())) block += `${name}: ${upRes.rawHeaders[i + 1]}\r\n`;
    }
    socket.write(`${block}Connection: close\r\n\r\n`);
    pipeline(upRes, socket, () => {});
  });
  upReq.on("error", () => {
    if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const abandon = (): void => {
    if (!upgraded) upReq.destroy();
  };
  socket.on("error", abandon);
  socket.on("close", abandon);
  upReq.end();
}

/**
 * A tunnel: raw bytes both ways over a WebSocket, binary frames. If the far
 * end cannot be reached, one text frame says why — `{"type":"error",
 * "message"}` — and the socket closes. Back-pressure is the streams'.
 */
function tunnel(ws: WebSocket, connect: () => net.Socket, what: string): void {
  const conn = connect();
  let open = false;
  const fail = (message: string): void => {
    try {
      ws.send(JSON.stringify({ type: "error", message }));
      ws.close(1011, "tunnel failed");
    } catch {
      ws.terminate();
    }
  };
  conn.once("error", (err: NodeJS.ErrnoException) => {
    if (!open) fail(`cannot reach ${what}: ${err.code ?? err.message}`);
    else ws.terminate();
  });
  conn.once("connect", () => {
    open = true;
    const stream = createWebSocketStream(ws);
    stream.on("error", () => conn.destroy());
    pipeline(conn, stream, () => ws.terminate());
    pipeline(stream, conn, () => conn.destroy());
  });
  ws.once("close", () => {
    if (!open) conn.destroy();
  });
}

export function createDataPlane(opts: DataPlaneOptions): http.Server {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  const server = http.createServer({ requestTimeout: 0, headersTimeout: 20_000, keepAliveTimeout: 135_000 }, (req, res) => {
    const target = parseAppTarget(req.url ?? "");
    if (!target) return plain(res, 404, "not found");
    if (opts.refusedAppPorts().has(target.port)) return plain(res, 403, "that port belongs to agentbox itself");
    proxyApp(req, res, target);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = req.url ?? "";
    const app = parseAppTarget(url);
    if (app) {
      if (opts.refusedAppPorts().has(app.port)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      proxyAppUpgrade(req, socket, head, app);
      return;
    }
    const tcp = /^\/tunnel\/tcp\/(\d{1,5})$/.exec(url);
    const port = tcp ? Number(tcp[1]) : 0;
    if (tcp && port >= 1 && port <= 65535) {
      wss.handleUpgrade(req, socket, head, (ws) => tunnel(ws, () => net.connect({ ...LOOPBACK, port }), `port ${port}`));
      return;
    }
    if (url === "/tunnel/herdr") {
      wss.handleUpgrade(req, socket, head, (ws) => tunnel(ws, () => net.connect(opts.herdrSocket), "herdr"));
      return;
    }
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("close", () => wss.close());
  return server;
}
