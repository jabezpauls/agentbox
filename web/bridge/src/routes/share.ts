import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { wsOriginGuard } from "../ws-origin.js";
import { proxyHttpRequest, proxyWebSocket, type ProxyTarget } from "./proxy-core.js";
import { ID_PATTERN, type ShareStore } from "../share/store.js";

interface TokenParams {
  token: string;
  "*": string;
}

function shareUrl(config: Config, req: FastifyRequest, token: string): string {
  const origin = config.publicUrl ?? `${req.protocol}://${req.headers.host ?? "127.0.0.1"}`;
  return `${origin}/s/${token}/`;
}

/**
 * The owner's share API, under the authenticated base path. Minting, listing,
 * extending and revoking public preview links. Guarded by the proxy's login the
 * same as every other `/api` route; `previewSharing` off makes minting a 403 so
 * an operator can turn the feature off entirely.
 */
export function registerShareApiRoutes(app: FastifyInstance, config: Config, store: ShareStore): void {
  const parsePort = (raw: unknown): number | null => {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (config.port && port === config.port) return null;
    return port;
  };

  app.post<{ Body: { port?: unknown } }>("/api/preview/shares", async (req, reply) => {
    if (!config.previewSharing) return reply.code(403).send({ error: "sharing is disabled" });
    const port = parsePort(req.body?.port);
    if (port === null) return reply.code(400).send({ error: "invalid port" });
    const share = await store.create(port);
    return { ...share, url: shareUrl(config, req, share.token) };
  });

  app.get("/api/preview/shares", async () => {
    if (!config.previewSharing) return [];
    const shares = await store.list();
    return shares.map((s) => ({ ...s, url: config.publicUrl ? `${config.publicUrl}/s/${s.token}/` : `/s/${s.token}/` }));
  });

  app.delete<{ Params: { id: string } }>("/api/preview/shares/:id", async (req, reply) => {
    if (!ID_PATTERN.test(req.params.id)) return reply.code(400).send({ error: "invalid share id" });
    const revoked = await store.revoke(req.params.id);
    if (!revoked) return reply.code(404).send({ error: "no such share" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/preview/shares/:id/extend", async (req, reply) => {
    if (!config.previewSharing) return reply.code(403).send({ error: "sharing is disabled" });
    if (!ID_PATTERN.test(req.params.id)) return reply.code(400).send({ error: "invalid share id" });
    const share = await store.extend(req.params.id);
    if (!share) return reply.code(404).send({ error: "no such share" });
    return { ...share, url: shareUrl(config, req, share.token) };
  });
}

/**
 * The public share route, mounted at the server root (NOT under the base path)
 * so Caddy's `handle /s/*` block — which carries no basic auth — reaches it
 * directly. A token resolves to a loopback port and the request is proxied to
 * it exactly like the private preview, keyed by token instead of port-in-path.
 * An unknown, expired or revoked token is a plain 404 that reveals nothing, and
 * with sharing off every token 404s. This is the only unauthenticated route the
 * bridge serves; it is a fixed reverse proxy to one mapped port, never a
 * general proxy.
 */
export function registerPublicShareRoutes(
  app: FastifyInstance,
  config: Config,
  store: ShareStore,
): void {
  const ownPorts = (): Set<number> => {
    const set = new Set<number>();
    if (config.port) set.add(config.port);
    const addr = app.server.address();
    if (typeof addr === "object" && addr) set.add(addr.port);
    return set;
  };

  const targetFor = async (req: FastifyRequest): Promise<ProxyTarget | null> => {
    if (!config.previewSharing) return null;
    const token = (req.params as TokenParams).token;
    const port = await store.resolve(token);
    if (port === null || ownPorts().has(port)) return null;
    const prefix = `/s/${token}`;
    const raw = req.raw.url ?? "";
    let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
    if (!rest.startsWith("/")) rest = `/${rest}`;
    return { port, targetPath: rest, prefix };
  };

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    // Bare token: redirect to the slash form so relative asset URLs resolve.
    scope.get<{ Params: { token: string } }>("/s/:token", async (req, reply) => {
      if (!config.previewSharing || (await store.resolve(req.params.token)) === null) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.redirect(`/s/${req.params.token}/`, 302);
    });

    const httpHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const target = await targetFor(req);
      if (target === null) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.hijack();
      proxyHttpRequest(req, reply, target, req.log);
    };

    scope.route<{ Params: TokenParams }>({
      method: ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      url: "/s/:token/*",
      handler: httpHandler,
    });

    scope.route<{ Params: TokenParams }>({
      method: "GET",
      url: "/s/:token/*",
      onRequest: wsOriginGuard,
      handler: httpHandler,
      wsHandler: (socket, req) => {
        void targetFor(req).then((target) => {
          if (target === null) {
            socket.close(1008, "no such share");
            return;
          }
          proxyWebSocket(socket, req, target, req.log);
        });
      },
    });
  });
}
