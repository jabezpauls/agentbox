import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * The header Caddy sets on its unauthenticated `/s/` branch, and only there.
 * Caddy deletes any client-supplied copy on every branch first, so its presence
 * means "this request skipped the login".
 */
export const PUBLIC_HEADER = "x-agentbox-public";

/** The only raw path shape an unauthenticated request may have. */
const PUBLIC_PATH = /^\/s\/[0-9a-f]{32}(\/|$)/;

/**
 * Path forms that different layers normalise differently. Caddy's `path`
 * matcher decodes and cleans; find-my-way routes on the raw string. Anything
 * that could read as one path to Caddy and another to the router is refused.
 */
const AMBIGUOUS = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|;|\/\//i;

function rawPath(req: FastifyRequest): string {
  const url = req.raw.url ?? "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * The part of a raw path that decides routing. Behind a proxy prefix — the
 * private preview `<base>/preview/<port>` or a share `/s/<token>` — the rest of
 * the path belongs to the previewed app and is forwarded verbatim (an app may
 * legitimately use `%2F` in its own URLs), so only the prefix is held to the
 * strict form. Every other path the bridge serves is checked whole.
 */
function routingPart(path: string, basePath: string): string {
  const preview = `${basePath}/preview/`;
  for (const prefix of [preview, "/s/"]) {
    if (path.startsWith(prefix)) {
      const end = path.indexOf("/", prefix.length);
      return end === -1 ? path : path.slice(0, end + 1);
    }
  }
  return path;
}

/**
 * Bridge-wide `onRequest` guard, applied to HTTP requests and websocket
 * upgrades alike. It is the decisive half of the `/s/` boundary: because it
 * judges the same raw string the router matches on, no normalisation
 * difference between Caddy and the bridge can turn a public request into a
 * private route.
 */
export function pathGuard(basePath: string) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    const path = rawPath(req);
    if (req.headers[PUBLIC_HEADER] !== undefined && !PUBLIC_PATH.test(path)) {
      // Uniform with an unknown token: a probe learns nothing.
      void reply.code(404).send({ error: "not found" });
      return;
    }
    if (AMBIGUOUS.test(routingPart(path, basePath))) {
      void reply.code(400).send({ error: "bad path" });
      return;
    }
    done();
  };
}
