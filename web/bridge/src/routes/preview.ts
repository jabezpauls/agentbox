import http from "node:http";
import { WebSocket } from "ws";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

interface PreviewParams {
  port: string;
  "*": string;
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

    const targetPath = (req: FastifyRequest): string => {
      const rest = (req.params as PreviewParams)["*"] ?? "";
      const q = req.raw.url?.includes("?") ? req.raw.url.slice(req.raw.url.indexOf("?")) : "";
      return `/${rest}${q}`;
    };

    const httpHandler = (req: FastifyRequest, reply: FastifyReply): void => {
      const port = validate(req, reply);
      if (port === null) return;
      reply.hijack();
      const proxyReq = http.request(
        {
          host: "127.0.0.1",
          port,
          method: req.method,
          path: targetPath(req),
          headers: { ...req.headers, host: `127.0.0.1:${port}` },
        },
        (proxyRes) => {
          reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(reply.raw);
        },
      );
      proxyReq.on("error", () => {
        if (!reply.raw.headersSent) reply.raw.writeHead(502);
        reply.raw.end();
      });
      req.raw.pipe(proxyReq);
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
      handler: httpHandler,
      wsHandler: (socket, req) => {
        const port = parsePort((req.params as PreviewParams).port);
        if (port === null) {
          socket.close(1008, "invalid preview port");
          return;
        }
        const upstream = new WebSocket(`ws://127.0.0.1:${port}${targetPath(req)}`);
        const pending: { data: Buffer; binary: boolean }[] = [];

        socket.on("message", (data: Buffer, isBinary: boolean) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary });
          } else {
            pending.push({ data, binary: isBinary });
          }
        });
        upstream.on("open", () => {
          for (const m of pending) upstream.send(m.data, { binary: m.binary });
          pending.length = 0;
        });
        upstream.on("message", (data: Buffer, isBinary: boolean) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
        });
        upstream.on("close", (code, reason) => {
          try {
            socket.close(code >= 1000 && code <= 4999 ? code : 1000, reason.toString());
          } catch {
            // client socket already gone
          }
        });
        upstream.on("error", () => {
          try {
            socket.close(1011, "upstream error");
          } catch {
            // client socket already gone
          }
        });
        socket.on("close", () => {
          try {
            upstream.close();
          } catch {
            // upstream already closing
          }
        });
      },
    });
  });
}
