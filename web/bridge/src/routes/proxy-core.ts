import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";

// Per RFC 7230 6.1, hop-by-hop headers must not be forwarded by a proxy.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// ws sets these itself on the upstream handshake; forwarding the client's would corrupt it.
const WS_HANDSHAKE_HEADERS = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "connection",
  "upgrade",
  "host",
]);

// The user's credentials for the appliance itself must never reach a port an
// agent opened. Caddy's `basic_auth` leaves `Authorization` on the request, so
// without this every preview would hand the previewed process the plaintext
// login for the whole box; `Cookie` is stripped for the same reason. A public
// `/s/` link carries no such credentials at all, but stripping them here keeps
// one hardened path for both callers.
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie"]);

const MAX_PENDING_BYTES = 1024 * 1024;

/** Upstream failures that mean "nothing is serving here", not "the app errored". */
const DOWN_ERRNOS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT"]);
/** Upstream statuses that a bare gateway returns when the app is not up. A 500
 * from a framework is the app rendering its own error and is passed through. */
const DOWN_STATUSES = new Set([502, 503, 504]);
/** Cap on how long the proxy waits for the upstream to answer at all. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** ws only permits these close codes to be sent back to a peer. */
function sendableCloseCode(code: number): number {
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/**
 * How a proxied request is addressed: the loopback `port` to reach, the
 * `targetPath` to request there (preserving percent-encoding), and the public
 * `prefix` that root-relative `Location`/`Set-Cookie` values are rewritten into
 * so a redirect or a cookie stays inside the same preview or share.
 */
export interface ProxyTarget {
  port: number;
  targetPath: string;
  prefix: string;
}

// Rewrite a root-relative Location so it stays inside the proxy's prefix,
// idempotently: an upstream that already emits a prefixed path (some frameworks
// honour X-Forwarded-Prefix) must not be prefixed twice.
function rewriteLocation(value: string, prefix: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  if (value === prefix || value.startsWith(`${prefix}/`)) return value;
  return `${prefix}${value}`;
}

// Prefix a Set-Cookie Path attribute so the cookie scopes to this preview/share,
// and strip any Domain attribute so a previewed page cannot widen a cookie onto
// the appliance's own domain. The Path match is case-insensitive (cookie
// attribute names are) and idempotent against an already-prefixed path.
function rewriteSetCookie(cookie: string, prefix: string): string {
  let out = cookie.replace(/;\s*path=(\/[^;]*)/i, (_m, p: string) => {
    if (p === prefix || p.startsWith(`${prefix}/`)) return `; Path=${p}`;
    return `; Path=${prefix}${p}`;
  });
  // Drop `Domain=…` entirely; without it the cookie stays scoped to the exact
  // host that served it, which is what we want for an agent's preview.
  out = out.replace(/;\s*domain=[^;]*/i, "");
  return out;
}

function buildResponseHeaders(
  upstreamHeaders: IncomingHttpHeaders,
  prefix: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (key === "location" && typeof value === "string") {
      out[key] = rewriteLocation(value, prefix);
    } else if (key === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      out[key] = cookies.map((c) => rewriteSetCookie(c, prefix));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The branded fallback the proxy returns instead of a bare upstream failure, so
 * a not-yet-started dev server is a calm in-app page rather than whatever the
 * edge (Cloudflare, the browser) would render for a 502. Self-contained: no
 * external CSS, and the palette is inlined from the Workbench tokens for both
 * themes. `X-Preview-Upstream: down` marks it so the panel's probe can tell it
 * apart from a real 200 without parsing the body.
 */
export function fallbackPage(port: number, kind: "down" | "error"): string {
  const title =
    kind === "error" ? `Port ${port} returned an error` : `Nothing is serving on port ${port}`;
  const detail =
    kind === "error"
      ? "The server on this port answered with an error. It may still be starting, or it may have crashed — check the pane that launched it."
      : "No server has answered on this port yet. If you just started one, give it a moment and retry.";
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
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
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

function sendFallback(reply: FastifyReply, port: number, kind: "down" | "error"): void {
  const clientRes = reply.raw;
  if (clientRes.headersSent || clientRes.destroyed) return;
  const body = Buffer.from(fallbackPage(port, kind), "utf8");
  clientRes.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    // Lets the panel's probe distinguish this from a real upstream 200 without
    // reading the body (a HEAD carries no body at all).
    "x-preview-upstream": "down",
  });
  if (reply.request.method === "HEAD") clientRes.end();
  else clientRes.end(body);
}

/**
 * Reverse-proxy one HTTP request to `127.0.0.1:<port>`. The reply must already
 * be hijacked. On an upstream that is refused, unreachable or answers with a
 * bare gateway status, a branded fallback page is served in place of the error.
 */
export function proxyHttpRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  target: ProxyTarget,
  log: FastifyBaseLogger,
): void {
  const { port, targetPath, prefix } = target;
  const clientReq = req.raw;
  const clientRes = reply.raw;

  const requestHeaders: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key) || CREDENTIAL_HEADERS.has(key)) continue;
    requestHeaders[key] = value;
  }
  requestHeaders.host = `127.0.0.1:${port}`;

  let settled = false;
  const proxyReq = http.request(
    { host: "127.0.0.1", port, method: req.method, path: targetPath, headers: requestHeaders },
    (proxyRes) => {
      settled = true;
      if (clientRes.destroyed) {
        proxyRes.destroy();
        return;
      }
      const status = proxyRes.statusCode ?? 502;
      // A bare gateway status means the port answered but the app is not up;
      // show the branded page rather than passing a 502 the edge would style.
      if (DOWN_STATUSES.has(status) && !clientRes.headersSent) {
        proxyRes.resume();
        sendFallback(reply, port, "error");
        return;
      }
      clientRes.writeHead(status, proxyRes.statusMessage, buildResponseHeaders(proxyRes.headers, prefix));
      proxyRes.pipe(clientRes);
      proxyRes.on("error", () => clientRes.destroy());
    },
  );

  proxyReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    // No answer at all within the window: treat it as not-up rather than let the
    // socket hang until the client or the edge gives up with an error page.
    if (!settled && !clientRes.headersSent) {
      settled = true;
      sendFallback(reply, port, "down");
    }
    proxyReq.destroy();
  });

  // A browser disconnect (or upstream failure) must never throw or leak the
  // opposite stream: log at debug and tear the pair down. A connection that was
  // refused or dropped before any bytes arrived becomes the branded page.
  proxyReq.on("error", (err: NodeJS.ErrnoException) => {
    log.debug({ err }, "preview upstream request error");
    if (!clientRes.headersSent) {
      if (!settled && DOWN_ERRNOS.has(err.code ?? "")) {
        settled = true;
        sendFallback(reply, port, "down");
        return;
      }
      try {
        clientRes.writeHead(502);
      } catch {
        // headers already flushed
      }
    }
    clientRes.destroy();
  });
  clientRes.on("error", (err) => {
    log.debug({ err }, "preview client response error");
    proxyReq.destroy();
  });
  clientReq.on("error", (err) => {
    log.debug({ err }, "preview client request error");
    proxyReq.destroy();
  });
  // Client went away mid-flight: abort the upstream so it does not leak.
  clientRes.on("close", () => proxyReq.destroy());
  clientReq.on("aborted", () => proxyReq.destroy());

  clientReq.pipe(proxyReq);
}

/** Reverse-proxy a WebSocket upgrade to `127.0.0.1:<port>`. */
export function proxyWebSocket(
  socket: WebSocket,
  req: FastifyRequest,
  target: ProxyTarget,
  log: FastifyBaseLogger,
): void {
  const { port, targetPath } = target;
  // @fastify/websocket (ws default) already accepted the client with the first
  // offered subprotocol; carry the same offer to the upstream.
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const acceptedByClient = socket.protocol;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || WS_HANDSHAKE_HEADERS.has(key)) continue;
    if (CREDENTIAL_HEADERS.has(key)) continue;
    if (key === "origin") {
      headers.origin = `http://127.0.0.1:${port}`;
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.host = `127.0.0.1:${port}`;

  const upstream = new WebSocket(`ws://127.0.0.1:${port}${targetPath}`, offered, { headers });
  const pending: { data: Buffer; binary: boolean }[] = [];
  let pendingBytes = 0;

  const closeClient = (code: number, reason?: string | Buffer): void => {
    try {
      socket.close(sendableCloseCode(code), reason);
    } catch {
      // client socket already gone
    }
  };
  const closeUpstream = (code: number, reason?: string | Buffer): void => {
    try {
      upstream.close(sendableCloseCode(code), reason);
    } catch {
      // upstream already closing
    }
  };

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    pendingBytes += data.length;
    if (pendingBytes > MAX_PENDING_BYTES) {
      closeClient(1009, "buffered frames exceeded limit");
      closeUpstream(1009, "buffered frames exceeded limit");
      return;
    }
    pending.push({ data, binary: isBinary });
  });

  upstream.on("open", () => {
    // If the upstream negotiated a subprotocol, the client must have been
    // accepted with the same one; otherwise the two sides disagree.
    if (upstream.protocol && upstream.protocol !== acceptedByClient) {
      closeClient(1002, "subprotocol mismatch");
      closeUpstream(1002, "subprotocol mismatch");
      return;
    }
    for (const m of pending) upstream.send(m.data, { binary: m.binary });
    pending.length = 0;
    pendingBytes = 0;
  });
  upstream.on("message", (data: Buffer, isBinary: boolean) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => closeClient(code, reason));
  upstream.on("error", (err) => {
    log.debug({ err }, "preview upstream websocket error");
    closeClient(1011, "upstream error");
  });
  socket.on("close", (code, reason) => closeUpstream(code, reason));
  socket.on("error", (err) => {
    log.debug({ err }, "preview client websocket error");
    closeUpstream(1011, "client error");
  });
}
