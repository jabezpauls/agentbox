import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { wsOriginGuard } from "../ws-origin.js";
import { proxyHttpRequest, proxyWebSocket, type ProxyTarget } from "./proxy-core.js";

interface PreviewParams {
  port: string;
  "*": string;
}

/**
 * Reverse-proxy any locally listening port under `/preview/<port>`.
 *
 * The proxying itself lives in {@link proxyHttpRequest}/{@link proxyWebSocket}
 * (shared with the public `/s/<token>` share route); this module only maps a
 * request to its loopback port and the prefix its redirects and cookies are
 * scoped into. We hand-roll the proxy rather than use `@fastify/http-proxy`
 * because the upstream port is chosen per request (it is in the path) and
 * `@fastify/http-proxy` ignores `getUpstream` for WebSocket upgrades whenever a
 * static `upstream` is configured — so dynamic-port ws proxying is impossible
 * with it. The proxy only ever targets `127.0.0.1`, never the bridge's own port.
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

  const proxyPrefix = (port: string): string => `/preview/${port}`;

  // Rebuild the upstream path straight from the raw URL (not the decoded wildcard
  // param) so percent-encoding is preserved end to end.
  const targetPath = (req: FastifyRequest): string => {
    const prefix = proxyPrefix((req.params as PreviewParams).port);
    const raw = req.raw.url ?? "";
    let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
    if (!rest.startsWith("/")) rest = `/${rest}`;
    return rest;
  };

  const resolveTarget = (req: FastifyRequest): ProxyTarget | null => {
    const port = parsePort((req.params as PreviewParams).port);
    if (port === null) return null;
    return { port, targetPath: targetPath(req), prefix: proxyPrefix((req.params as PreviewParams).port) };
  };

  await app.register(async (preview) => {
    // Proxy arbitrary bodies verbatim: strip inherited body parsers so nothing
    // consumes the request stream before we pipe it upstream.
    preview.removeAllContentTypeParsers();
    preview.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    // Bare port: redirect to the slash form so relative asset URLs resolve.
    preview.get<{ Params: { port: string } }>("/preview/:port", (req, reply) => {
      reply.redirect(`/preview/${req.params.port}/`, 302);
    });

    const httpHandler = (req: FastifyRequest, reply: FastifyReply): void => {
      const target = resolveTarget(req);
      if (target === null) {
        reply.code(400).send({ error: "invalid preview port" });
        return;
      }
      reply.hijack();
      proxyHttpRequest(req, reply, target, req.log);
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
        const target = resolveTarget(req);
        if (target === null) {
          socket.close(1008, "invalid preview port");
          return;
        }
        proxyWebSocket(socket, req, target, req.log);
      },
    });
  });
}
