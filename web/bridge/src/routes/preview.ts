import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { wsOriginGuard } from "../ws-origin.js";

interface PreviewParams {
  port: string;
  "*": string;
}

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
// login for the whole box; `Cookie` is stripped for the same reason.
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie"]);

const MAX_PENDING_BYTES = 1024 * 1024;

/** ws only permits these close codes to be sent back to a peer. */
function sendableCloseCode(code: number): number {
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/**
 * Reverse-proxy any locally listening port under `{base}/preview/<port>`.
 *
 * We hand-roll the proxy rather than use `@fastify/http-proxy` because the
 * upstream port is chosen per request (it is in the path) and, crucially,
 * `@fastify/http-proxy` ignores `getUpstream` for WebSocket upgrades whenever a
 * static `upstream` is configured (which it requires) — so dynamic-port ws
 * proxying is impossible with it. Node's `http` for requests plus `ws` for
 * upgrades gives correct per-request routing for both. The proxy only ever
 * targets `127.0.0.1`, never the bridge's own port.
 */
export async function registerPreviewRoutes(app: FastifyInstance, config: Config): Promise<void> {
  // Ports the proxy must never target: the configured port and whatever the
  // server actually bound to (they differ when the configured port is 0).
  const ownPorts = (): Set<number> => {
    const set = new Set<number>();
    if (config.port) set.add(config.port);
    const addr = app.server.address();
    if (typeof addr === "object" && addr) set.add(addr.port);
    return set;
  };

  const parsePort = (raw: string): number | null => {
    if (!/^\d+$/.test(raw)) return null;
    const port = Number(raw);
    if (port < 1 || port > 65535) return null;
    if (ownPorts().has(port)) return null;
    return port;
  };

  const proxyPrefix = (port: string): string => `${config.basePath}/preview/${port}`;

  // Rebuild the upstream path straight from the raw URL (not the decoded wildcard
  // param) so percent-encoding is preserved end to end.
  const targetPath = (req: FastifyRequest): string => {
    const prefix = proxyPrefix((req.params as PreviewParams).port);
    const raw = req.raw.url ?? "";
    let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
    if (!rest.startsWith("/")) rest = `/${rest}`;
    return rest;
  };

  // Rewrite a root-relative Location so it stays inside the preview prefix.
  const rewriteLocation = (value: string, port: string): string => {
    if (value.startsWith("/") && !value.startsWith("//")) return `${proxyPrefix(port)}${value}`;
    return value;
  };

  // Prefix a Set-Cookie Path=/... attribute so the cookie scopes to the preview.
  const rewriteSetCookie = (cookie: string, port: string): string =>
    cookie.replace(/;\s*[Pp]ath=(\/[^;]*)/, (_m, p: string) => `; Path=${proxyPrefix(port)}${p}`);

  const buildResponseHeaders = (
    upstreamHeaders: IncomingHttpHeaders,
    port: string,
  ): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(upstreamHeaders)) {
      if (value === undefined || HOP_BY_HOP.has(key)) continue;
      if (key === "location" && typeof value === "string") {
        out[key] = rewriteLocation(value, port);
      } else if (key === "set-cookie") {
        const cookies = Array.isArray(value) ? value : [value];
        out[key] = cookies.map((c) => rewriteSetCookie(c, port));
      } else {
        out[key] = value;
      }
    }
    return out;
  };

  await app.register(async (preview) => {
    // Proxy arbitrary bodies verbatim: strip inherited body parsers so nothing
    // consumes the request stream before we pipe it upstream.
    preview.removeAllContentTypeParsers();
    preview.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    // Bare port: redirect to the slash form so relative asset URLs resolve.
    preview.get<{ Params: { port: string } }>("/preview/:port", (req, reply) => {
      reply.redirect(`${config.basePath}/preview/${req.params.port}/`, 302);
    });

    const validate = (req: FastifyRequest, reply: FastifyReply): number | null => {
      const port = parsePort((req.params as PreviewParams).port);
      if (port === null) {
        reply.code(400).send({ error: "invalid preview port" });
        return null;
      }
      return port;
    };

    const httpHandler = (req: FastifyRequest, reply: FastifyReply): void => {
      const port = validate(req, reply);
      if (port === null) return;
      const portStr = (req.params as PreviewParams).port;
      reply.hijack();
      const clientReq = req.raw;
      const clientRes = reply.raw;

      const requestHeaders: IncomingHttpHeaders = {};
      for (const [key, value] of Object.entries(clientReq.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key) || CREDENTIAL_HEADERS.has(key)) continue;
        requestHeaders[key] = value;
      }
      requestHeaders.host = `127.0.0.1:${port}`;

      const proxyReq = http.request(
        { host: "127.0.0.1", port, method: req.method, path: targetPath(req), headers: requestHeaders },
        (proxyRes) => {
          if (clientRes.destroyed) {
            proxyRes.destroy();
            return;
          }
          clientRes.writeHead(
            proxyRes.statusCode ?? 502,
            proxyRes.statusMessage,
            buildResponseHeaders(proxyRes.headers, portStr),
          );
          proxyRes.pipe(clientRes);
          proxyRes.on("error", () => clientRes.destroy());
        },
      );

      // A browser disconnect (or upstream failure) must never throw or leak the
      // opposite stream: log at debug and tear the pair down.
      proxyReq.on("error", (err) => {
        req.log.debug({ err }, "preview upstream request error");
        if (!clientRes.headersSent) {
          try {
            clientRes.writeHead(502);
          } catch {
            // headers already flushed
          }
        }
        clientRes.destroy();
      });
      clientRes.on("error", (err) => {
        req.log.debug({ err }, "preview client response error");
        proxyReq.destroy();
      });
      clientReq.on("error", (err) => {
        req.log.debug({ err }, "preview client request error");
        proxyReq.destroy();
      });
      // Client went away mid-flight: abort the upstream so it does not leak.
      clientRes.on("close", () => proxyReq.destroy());
      clientReq.on("aborted", () => proxyReq.destroy());

      clientReq.pipe(proxyReq);
    };

    // Non-GET methods carry no websocket handler (@fastify/websocket only
    // allows wsHandler on GET), but still proxy their bodies through.
    preview.route<{ Params: PreviewParams }>({
      method: ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      url: "/preview/:port/*",
      handler: httpHandler,
    });

    preview.route<{ Params: PreviewParams }>({
      method: "GET",
      url: "/preview/:port/*",
      // Plain requests pass through; only the websocket upgrade is origin-checked.
      onRequest: wsOriginGuard,
      handler: httpHandler,
      wsHandler: (socket, req) => {
        const port = parsePort((req.params as PreviewParams).port);
        if (port === null) {
          socket.close(1008, "invalid preview port");
          return;
        }

        // @fastify/websocket (ws default) already accepted the client with the
        // first offered subprotocol; carry the same offer to the upstream.
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

        const upstream = new WebSocket(`ws://127.0.0.1:${port}${targetPath(req)}`, offered, {
          headers,
        });
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
          req.log.debug({ err }, "preview upstream websocket error");
          closeClient(1011, "upstream error");
        });
        socket.on("close", (code, reason) => closeUpstream(code, reason));
        socket.on("error", (err) => {
          req.log.debug({ err }, "preview client websocket error");
          closeUpstream(1011, "client error");
        });
      },
    });
  });
}
