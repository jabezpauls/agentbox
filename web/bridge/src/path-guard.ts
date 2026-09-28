import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Path forms that different layers normalise differently. The gate refuses
 * them before routing; the bridge refuses them too, on the raw string its
 * router matches, so no normalisation difference between the gate and the
 * router can make one path read as another. (Apps are not served here at all:
 * they live on the data plane, see data-plane.ts.)
 */
const AMBIGUOUS = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|;|\/\//i;

function rawPath(req: FastifyRequest): string {
  const url = req.raw.url ?? "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * The part of a raw path that decides routing: all of it, except under the
 * WebDAV mount. WebDAV names files in its path, and a filename may hold `;`, a
 * backslash or anything else. The DAV handler decodes each segment itself and
 * refuses `.`, `..`, empty names and encoded slashes before a path reaches the
 * filesystem, so here only its prefix is held to the strict form.
 */
function routingPart(path: string): string {
  if (path === "/api/dav" || path.startsWith("/api/dav/")) return "/api/dav/";
  return path;
}

/** Bridge-wide `onRequest` guard, applied to HTTP requests and websocket upgrades alike. */
export function pathGuard() {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    if (AMBIGUOUS.test(routingPart(rawPath(req)))) {
      void reply.code(400).send({ error: "bad path" });
      return;
    }
    done();
  };
}
