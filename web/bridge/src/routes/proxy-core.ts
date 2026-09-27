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

/**
 * How long to wait for the TCP connection to the upstream. Loopback either
 * connects at once or is refused, so this only matters for a wedged listener.
 */
let connectTimeoutMs = 10_000;
/**
 * How long to wait for the upstream's response to *start* — its status line.
 * Generous, because a dev server's first compile can take a while, and kept
 * under Cloudflare's 100s origin timeout so the bridge answers before the edge
 * does. Once headers arrive there is no timeout at all: an SSE stream or a
 * long-lived download is the app's business.
 */
let firstByteTimeoutMs = 90_000;

/** Shorten the upstream windows so tests can observe them; never used in production. */
export function setProxyTimeouts(t: { connectMs?: number; firstByteMs?: number }): void {
  if (t.connectMs !== undefined) connectTimeoutMs = t.connectMs;
  if (t.firstByteMs !== undefined) firstByteTimeoutMs = t.firstByteMs;
}

/** Headers the proxy never passes back from an upstream. */
const DROPPED_RESPONSE_HEADERS = new Set([
  // Would let a previewed page register a service worker scoped above its own
  // prefix — over the Workbench itself.
  "service-worker-allowed",
]);

/**
 * The sandbox a public share is served under. An opaque origin: the shared
 * page gets none of the box's cookies, storage or same-origin access, even when
 * opened as a top-level tab where no iframe `sandbox` attribute applies.
 */
export const SHARE_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals";

/**
 * True for a request that is loading a page (a top-level navigation or a frame)
 * rather than a script's fetch. Only these may be answered with the branded
 * fallback page; an XHR or fetch must see a real failure status it can handle.
 */
function isNavigation(req: FastifyRequest): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string") return dest === "document" || dest === "iframe" || dest === "frame";
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/html");
}

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
  /** Serve every response under {@link SHARE_SANDBOX_CSP} (public shares). */
  sandbox?: boolean;
  /**
   * Register a way to tear this exchange down; returns its unregister. Lets a
   * revoked or expired share cut an open stream or socket immediately.
   */
  track?: (close: () => void) => () => void;
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
  sandbox: boolean,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined || HOP_BY_HOP.has(key) || DROPPED_RESPONSE_HEADERS.has(key)) continue;
    if (key === "location" && typeof value === "string") {
      out[key] = rewriteLocation(value, prefix);
    } else if (key === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      out[key] = cookies.map((c) => rewriteSetCookie(c, prefix));
    } else {
      out[key] = value;
    }
  }
  if (sandbox) {
    // Added alongside any policy the app sets: browsers enforce every CSP
    // header, so the app can tighten this but never loosen it.
    const csp: string = "content-security-policy";
    const existing = out[csp];
    const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
    out[csp] = [...list, SHARE_SANDBOX_CSP];
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

/**
 * Answer for an upstream that never responded: the branded page for a page
 * load, a plain 502 for a script's request. Both carry `X-Preview-Upstream:
 * down` so the panel's probe can recognise either without reading a body.
 */
function sendUpstreamDown(req: FastifyRequest, reply: FastifyReply, port: number, sandbox: boolean): void {
  const clientRes = reply.raw;
  if (clientRes.headersSent || clientRes.destroyed) return;
  const headers: http.OutgoingHttpHeaders = { "cache-control": "no-store", "x-preview-upstream": "down" };
  if (sandbox) headers["content-security-policy"] = SHARE_SANDBOX_CSP;
  if (isNavigation(req)) {
    const body = Buffer.from(fallbackPage(port), "utf8");
    clientRes.writeHead(200, {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
    });
    if (req.method === "HEAD") clientRes.end();
    else clientRes.end(body);
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: "nothing is serving on this port" }), "utf8");
  clientRes.writeHead(502, {
    ...headers,
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  if (req.method === "HEAD") clientRes.end();
  else clientRes.end(body);
}

/**
 * Reverse-proxy one HTTP request to `127.0.0.1:<port>`. The reply must already
 * be hijacked. When the upstream cannot be reached at all — refused,
 * unreachable, or silent past the connect/first-byte window — a page load gets
 * the branded fallback and a script's request a marked 502. Anything the
 * upstream actually sends, error statuses included, is passed through as-is.
 */
export function proxyHttpRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  target: ProxyTarget,
  log: FastifyBaseLogger,
): void {
  const { port, targetPath, prefix } = target;
  const sandbox = target.sandbox === true;
  const clientReq = req.raw;
  const clientRes = reply.raw;

  const requestHeaders: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key) || CREDENTIAL_HEADERS.has(key)) continue;
    requestHeaders[key] = value;
  }
  requestHeaders.host = `127.0.0.1:${port}`;

  // `started` flips once the upstream's status line arrives; before that any
  // failure is "nothing is serving", after it the stream is the app's own.
  let started = false;
  let untrack = (): void => {};
  const proxyReq = http.request(
    { host: "127.0.0.1", port, method: req.method, path: targetPath, headers: requestHeaders },
    (proxyRes) => {
      started = true;
      clearTimeout(firstByte);
      if (clientRes.destroyed) {
        proxyRes.destroy();
        return;
      }
      clientRes.writeHead(
        proxyRes.statusCode ?? 502,
        proxyRes.statusMessage,
        buildResponseHeaders(proxyRes.headers, prefix, sandbox),
      );
      proxyRes.pipe(clientRes);
      proxyRes.on("error", () => clientRes.destroy());
    },
  );

  const giveUp = (): void => {
    if (started) return;
    started = true;
    sendUpstreamDown(req, reply, port, sandbox);
    proxyReq.destroy();
  };
  const firstByte = setTimeout(giveUp, firstByteTimeoutMs);
  firstByte.unref?.();
  proxyReq.on("socket", (sock) => {
    if (!sock.connecting) return;
    const connect = setTimeout(giveUp, connectTimeoutMs);
    connect.unref?.();
    sock.once("connect", () => clearTimeout(connect));
    sock.once("close", () => clearTimeout(connect));
  });

  if (target.track) {
    untrack = target.track(() => {
      proxyReq.destroy();
      clientRes.destroy();
    });
  }

  // A browser disconnect (or upstream failure) must never throw or leak the
  // opposite stream: log at debug and tear the pair down.
  proxyReq.on("error", (err: NodeJS.ErrnoException) => {
    log.debug({ err }, "preview upstream request error");
    if (!started && !clientRes.headersSent) {
      clearTimeout(firstByte);
      giveUp();
      return;
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
  clientRes.on("close", () => {
    clearTimeout(firstByte);
    untrack();
    proxyReq.destroy();
  });
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
  const untrack = target.track
    ? target.track(() => {
        closeClient(1008, "share ended");
        closeUpstream(1000, "share ended");
      })
    : (): void => {};
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
  socket.on("close", (code, reason) => {
    untrack();
    closeUpstream(code, reason);
  });
  socket.on("error", (err) => {
    log.debug({ err }, "preview client websocket error");
    closeUpstream(1011, "client error");
  });
}
