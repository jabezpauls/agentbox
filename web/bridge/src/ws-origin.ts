import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * WebSocket handshakes are ordinary HTTP requests that the same-origin policy
 * does not restrain: any page the browser loads can open a socket to this
 * bridge, and the browser will attach the cached Basic credentials for it. The
 * proxy's login therefore does not protect `/ws/events` (a session snapshot) or
 * `/ws/terminal` (a shell) from a hostile page in another tab — only an
 * `Origin` check does.
 *
 * The Workbench is always served from the same host the socket is opened on, so
 * a legitimate upgrade carries an `Origin` naming this request's own `Host`.
 * Comparing against the request rather than a configured origin keeps the
 * check correct under any domain, any base path, and the per-port preview
 * hostnames, none of which the bridge knows about.
 *
 * A sandboxed preview iframe sends `Origin: null`, and a page that wants to
 * escape that sandbox would too; both are refused along with everything else
 * that does not match.
 */

/** True when this request is a WebSocket upgrade rather than a plain GET. */
export function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

/**
 * True when `Origin` names this request's own host.
 *
 * Only the host is compared, deliberately. The scheme cannot be: TLS
 * terminates before the bridge, and the last hop — our own Caddy — rewrites
 * `X-Forwarded-Proto` to its own listener's scheme rather than passing on what
 * a fronting proxy sent, so behind a Cloudflare Tunnel or any TLS-terminating
 * nginx the browser's `https://host` would be compared against a forwarded
 * `http` and every upgrade would be refused. The host equality is what carries
 * the weight anyway: anyone able to serve `http://<this host>` to the browser
 * is already a man in the middle of the connection this check protects. ttyd's
 * own `--check-origin` compares host and port for the same reason.
 */
export function isSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || origin === "" || typeof host !== "string" || host === "") {
    return false;
  }
  // `Origin: null` is a string, not an origin: sandboxed documents and some
  // redirects send it, and it matches nothing.
  if (origin === "null") return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.host.toLowerCase() === host.toLowerCase();
}

/**
 * Route `onRequest` hook: refuse a cross-origin WebSocket upgrade before it is
 * accepted. Plain HTTP requests pass through untouched, which matters for the
 * preview route, where the same URL serves documents and sockets.
 */
export function wsOriginGuard(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!isWebSocketUpgrade(req) || isSameOrigin(req)) {
    done();
    return;
  }
  req.log.debug({ origin: req.headers.origin }, "rejected cross-origin websocket upgrade");
  void reply.code(403).send({ error: "origin not allowed" });
}
