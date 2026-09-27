import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { wsOriginGuard } from "../ws-origin.js";
import { proxyHttpRequest, proxyWebSocket, type ProxyTarget } from "./proxy-core.js";
import { ID_PATTERN, type ShareStore, type ShareView } from "../share/store.js";
import type { LiveShares } from "../share/live.js";

interface TokenParams {
  token: string;
  "*": string;
}

export interface ShareDeps {
  store: ShareStore;
  live: LiveShares;
  /**
   * True for a port no share may reach: agentbox's own services, the bridge
   * itself, and anything the ports classifier currently marks as system.
   */
  refusedPort(port: number): boolean;
}

/**
 * The absolute link a share is opened at. Built the same way for a mint and a
 * list so the panel never shows two spellings of one link.
 */
function shareUrl(config: Config, req: FastifyRequest, token: string): string {
  const origin = config.publicUrl ?? `${req.protocol}://${req.headers.host ?? "127.0.0.1"}`;
  return `${origin}/s/${token}/`;
}

function withUrl(config: Config, req: FastifyRequest, share: ShareView): ShareView & { url: string } {
  return { ...share, url: shareUrl(config, req, share.token) };
}

/**
 * The owner's share API, under the authenticated base path: mint, list, extend
 * and revoke public preview links. Guarded by the proxy's login like every
 * other `/api` route; `previewSharing` off makes minting a 403.
 */
export function registerShareApiRoutes(app: FastifyInstance, config: Config, deps: ShareDeps): void {
  const { store, live } = deps;

  const parsePort = (raw: unknown): number | null => {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return port;
  };

  app.post<{ Body: { port?: unknown } }>("/api/preview/shares", async (req, reply) => {
    if (!config.previewSharing) return reply.code(403).send({ error: "sharing is disabled" });
    const port = parsePort(req.body?.port);
    if (port === null) return reply.code(400).send({ error: "invalid port" });
    if (deps.refusedPort(port)) {
      return reply.code(400).send({ error: "that port belongs to agentbox itself and cannot be shared" });
    }
    return withUrl(config, req, await store.create(port));
  });

  app.get("/api/preview/shares", async (req) => {
    if (!config.previewSharing) return [];
    return (await store.list()).map((s) => withUrl(config, req, s));
  });

  app.delete<{ Params: { id: string } }>("/api/preview/shares/:id", async (req, reply) => {
    if (!ID_PATTERN.test(req.params.id)) return reply.code(400).send({ error: "invalid share id" });
    const revoked = await store.revoke(req.params.id);
    if (!revoked) return reply.code(404).send({ error: "no such share" });
    // Revocation is immediate for new requests via the store; this makes it
    // immediate for connections a viewer already has open, too.
    live.closeAll(revoked.token);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/preview/shares/:id/extend", async (req, reply) => {
    if (!config.previewSharing) return reply.code(403).send({ error: "sharing is disabled" });
    if (!ID_PATTERN.test(req.params.id)) return reply.code(400).send({ error: "invalid share id" });
    const share = await store.extend(req.params.id);
    if (!share) return reply.code(404).send({ error: "no such share" });
    return withUrl(config, req, share);
  });
}

/**
 * The public share route, mounted at the server root (NOT under the base path)
 * so Caddy's unauthenticated `/s/` branch reaches it directly. A token
 * resolves to a loopback port and the request is proxied exactly like the
 * private preview, keyed by token instead of port-in-path, with two additions:
 * every response is served under a CSP sandbox (an opaque origin, so the page
 * gets nothing of the Workbench's origin even full screen), and every exchange
 * is tracked so a revoke or an expiry cuts it. An unknown, expired or revoked
 * token — or one mapped to an infrastructure port — is a plain 404.
 */
export function registerPublicShareRoutes(app: FastifyInstance, config: Config, deps: ShareDeps): void {
  const { store, live } = deps;

  const targetFor = async (req: FastifyRequest): Promise<ProxyTarget | null> => {
    if (!config.previewSharing) return null;
    const token = (req.params as TokenParams).token;
    const port = await store.resolve(token);
    if (port === null || deps.refusedPort(port)) return null;
    const prefix = `/s/${token}`;
    const raw = req.raw.url ?? "";
    let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
    if (!rest.startsWith("/")) rest = `/${rest}`;
    return {
      port,
      targetPath: rest,
      prefix,
      sandbox: true,
      track: (close) => live.track(token, close),
    };
  };

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    // Bare token: redirect to the slash form so relative asset URLs resolve.
    scope.get<{ Params: { token: string } }>("/s/:token", async (req, reply) => {
      if ((await targetFor(req)) === null) return reply.code(404).send({ error: "not found" });
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

/**
 * Cut open exchanges on shares that have expired since they connected. Revoke
 * closes its own connections at once; expiry has no event, so this sweeps.
 */
export function startExpirySweep(store: ShareStore, live: LiveShares, everyMs: number): () => void {
  const timer = setInterval(() => {
    for (const token of live.tokens()) {
      void store.resolve(token).then((port) => {
        if (port === null) live.closeAll(token);
      });
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
