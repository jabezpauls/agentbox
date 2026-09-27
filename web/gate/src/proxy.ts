import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import { setsOurCookie, stripOurCookies } from "./cookies.js";
import type { Upstream } from "./config.js";

/**
 * Forwarding to the sandbox, with the second rule built in: no front-door
 * credential ever enters the sandbox. Every request and WebSocket upgrade that
 * leaves the gate has lost `Authorization`, `Proxy-Authorization` and the
 * gate's own cookies, whatever route it took; every response coming back loses
 * any attempt to set one of the gate's cookies.
 *
 * Bodies stream both ways and are never buffered, so an editor download, a
 * terminal and a long poll all behave as they would against the upstream
 * directly.
 */

// RFC 7230 §6.1: meaningful for one connection only, never forwarded.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Front-door credentials. Stripped from everything forwarded. */
const CREDENTIALS = new Set(["authorization", "proxy-authorization"]);

/**
 * Headers that speak for the client's identity or trust level. The gate
 * rewrites the forwarding trio itself; the rest are dropped so nothing
 * upstream reads a claim the gate did not make. `X-Agentbox-Public` is the
 * marker the proxy used to set on public `/s/` requests — the gate makes
 * nothing public that way, so no request may carry it.
 */
const IDENTITY = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-agentbox-public",
  "x-agentbox-client-ip",
]);

/**
 * Response headers the gate sets itself on everything it serves, and headers
 * no upstream may send at all. `Service-Worker-Allowed` would let a worker
 * claim a scope above its own script's directory — from a page in the
 * sandbox, over the whole box, the sign-in page included.
 */
const OWN_RESPONSE_HEADERS = new Set(["referrer-policy", "x-content-type-options", "service-worker-allowed"]);

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
];

/** Control-plane HTML must not be framed by another site. */
export const FRAME_ANCESTORS = "frame-ancestors 'self'";

/** What the gate knows about the client, restated to the upstream. */
export interface Forwarded {
  clientIp: string;
  proto: string;
  host: string;
}

export interface ProxyOptions {
  /** The raw path and query to request upstream. */
  target: string;
  forwarded: Forwarded;
  /**
   * A last say over the response headers (as name/value pairs, after the
   * gate's own filtering), for a route that needs its own policy.
   */
  responseHeaders?: (pairs: Array<[string, string]>, upstream: IncomingMessage) => Array<[string, string]>;
  /** Called as the client sends data over an upgraded connection. */
  onClientData?: () => void;
}

function connectionTokens(req: IncomingMessage): Set<string> {
  const raw = req.headers.connection;
  const list = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return new Set(
    list
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The headers to send upstream: the client's, minus hop-by-hop headers,
 * credentials, the gate's cookies and identity claims, plus the gate's own
 * account of who is asking. `Host` passes through unchanged — code-server,
 * ttyd and the bridge compare a WebSocket's `Origin` against it.
 */
export function forwardRequestHeaders(req: IncomingMessage, fwd: Forwarded, upgrade = false): OutgoingHttpHeaders {
  const listed = connectionTokens(req);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || listed.has(name) || CREDENTIALS.has(name) || IDENTITY.has(name)) continue;
    if (name === "cookie") {
      const kept = stripOurCookies(Array.isArray(value) ? value.join("; ") : value);
      if (kept !== undefined) out.cookie = kept;
      continue;
    }
    out[name] = value;
  }
  if (upgrade) {
    out.connection = "Upgrade";
    out.upgrade = req.headers.upgrade ?? "websocket";
  } else if (req.headers["transfer-encoding"] !== undefined && req.headers["content-length"] === undefined) {
    // A body of unknown length must stay chunked on the way out: Node only
    // chunks some methods by default, and a DELETE body would otherwise go
    // upstream unframed.
    out["transfer-encoding"] = "chunked";
  }
  out["x-forwarded-for"] = fwd.clientIp;
  out["x-forwarded-proto"] = fwd.proto;
  out["x-forwarded-host"] = fwd.host;
  return out;
}

/** The upstream's response headers as the client will see them. */
export function filterResponseHeaders(upstream: IncomingMessage, forUpgrade = false): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const raw = upstream.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const value = raw[i + 1] as string;
    const lower = name.toLowerCase();
    if (!forUpgrade && HOP_BY_HOP.has(lower)) continue;
    if (OWN_RESPONSE_HEADERS.has(lower)) continue;
    // A process in the sandbox must not be able to plant or clear the owner's
    // session: that is a way to log them out, or into a session of its choosing.
    if (lower === "set-cookie" && setsOurCookie(value)) continue;
    pairs.push([name, value]);
  }
  for (const [n, v] of SECURITY_HEADERS) pairs.push([n, v]);
  const type = upstream.headers["content-type"] ?? "";
  if (/^\s*text\/html/i.test(type)) pairs.push(["Content-Security-Policy", FRAME_ANCESTORS]);
  return pairs;
}

// Keep-alive to the sandbox, without a socket timeout: a long poll or a quiet
// download is the upstream's business, not the gate's.
const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });

function reasonPhrase(res: IncomingMessage): string {
  return res.statusMessage || http.STATUS_CODES[res.statusCode ?? 502] || "";
}

/** How long to wait for a TCP connection to a sandbox service before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

function flatten(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [n, v] of pairs) out.push(n, v);
  return out;
}

function badGateway(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, flatten([["Content-Type", "text/plain; charset=utf-8"], ...SECURITY_HEADERS]));
  res.end("agentbox: that service is not answering. It may still be starting.\n");
}

/** Forward one HTTP request to `upstream` and stream its answer back. */
export function proxyHttp(upstream: Upstream, req: IncomingMessage, res: ServerResponse, opts: ProxyOptions): void {
  const upReq = http.request({
    host: upstream.host,
    port: upstream.port,
    method: req.method,
    path: opts.target,
    headers: forwardRequestHeaders(req, opts.forwarded),
    agent,
  });

  const connectTimer = setTimeout(() => upReq.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
  upReq.once("socket", (s) => {
    if (!s.connecting) clearTimeout(connectTimer);
    else s.once("connect", () => clearTimeout(connectTimer));
  });

  upReq.on("response", (upRes) => {
    clearTimeout(connectTimer);
    let pairs = filterResponseHeaders(upRes);
    if (opts.responseHeaders) pairs = opts.responseHeaders(pairs, upRes);
    res.writeHead(upRes.statusCode ?? 502, reasonPhrase(upRes), flatten(pairs));
    pipeline(upRes, res, () => {});
  });

  upReq.on("error", () => {
    clearTimeout(connectTimer);
    badGateway(res);
  });

  // The client going away ends the upstream exchange too, so a closed tab does
  // not leave a long poll or a download running in the sandbox.
  res.on("close", () => {
    if (!res.writableFinished) upReq.destroy();
  });

  pipeline(req, upReq, () => {});
}

/** Write a bare HTTP response on a socket that was about to be upgraded, and close it. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
}

function statusBlock(res: IncomingMessage, pairs: Array<[string, string]>): string {
  let out = `HTTP/1.1 ${res.statusCode} ${reasonPhrase(res)}\r\n`;
  for (const [n, v] of pairs) out += `${n}: ${v}\r\n`;
  return `${out}\r\n`;
}

/**
 * Forward a WebSocket (or any HTTP/1.1 upgrade) and then splice the two
 * sockets together. Frames are relayed as bytes, never re-framed, so
 * subprotocols (ttyd's `tty`), extensions and close codes pass through intact.
 */
export function proxyUpgrade(upstream: Upstream, req: IncomingMessage, socket: Duplex, head: Buffer, opts: ProxyOptions): void {
  const upReq = http.request({
    host: upstream.host,
    port: upstream.port,
    method: req.method,
    path: opts.target,
    headers: forwardRequestHeaders(req, opts.forwarded, true),
    // A dedicated connection: once upgraded it belongs to this socket alone.
    agent: false,
  });

  const connectTimer = setTimeout(() => upReq.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
  let upgraded = false;

  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    clearTimeout(connectTimer);
    upgraded = true;
    if (socket.destroyed) {
      upSocket.destroy();
      return;
    }
    let pairs = filterResponseHeaders(upRes, true).filter(([n]) => n.toLowerCase() !== "content-security-policy");
    if (opts.responseHeaders) pairs = opts.responseHeaders(pairs, upRes);
    socket.write(statusBlock(upRes, pairs));
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.setNoDelay(true);
    const end = (): void => {
      socket.destroy();
      upSocket.destroy();
    };
    upSocket.on("error", end);
    socket.on("error", end);
    upSocket.on("close", end);
    socket.on("close", end);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    if (opts.onClientData) socket.on("data", opts.onClientData);
  });

  // The upstream answered without upgrading (a 403 from an origin check, a
  // 404): relay that answer as it is.
  upReq.on("response", (upRes) => {
    clearTimeout(connectTimer);
    // The body arrives de-chunked and hop-by-hop headers are already gone, so
    // the connection's close is what delimits it on this raw socket.
    let pairs = filterResponseHeaders(upRes);
    if (opts.responseHeaders) pairs = opts.responseHeaders(pairs, upRes);
    pairs.push(["Connection", "close"]);
    socket.write(statusBlock(upRes, pairs));
    pipeline(upRes, socket, () => {});
  });

  upReq.on("error", () => {
    clearTimeout(connectTimer);
    refuseUpgrade(socket, 502, "Bad Gateway");
  });
  const abandon = (): void => {
    if (!upgraded) upReq.destroy();
  };
  socket.on("error", abandon);
  socket.on("close", abandon);

  upReq.end();
}

/** The helper later routes build on: one upstream, both kinds of exchange. */
export function proxyTo(upstream: Upstream) {
  return {
    http: (req: IncomingMessage, res: ServerResponse, opts: ProxyOptions) => proxyHttp(upstream, req, res, opts),
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, opts: ProxyOptions) =>
      proxyUpgrade(upstream, req, socket, head, opts),
  };
}
