import type { FastifyReply, FastifyRequest } from "fastify";

/** Headers a proxy adds: their presence means the request came through one. */
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];

/**
 * True when a request comes from inside the sandbox rather than through the
 * front door. Every sandbox service shares the bridge's network namespace, so
 * a process in it — the editor's extension host, an agent's status line —
 * connects over loopback with a Node client that sends no `Origin`. A browser
 * always sends one on a websocket handshake and on a cross-origin POST, and a
 * proxy — the gate — adds forwarding headers, so neither passes even when the
 * proxy itself is on loopback.
 */
export function isFromInside(req: FastifyRequest): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "::1" || /^(::ffff:)?127\./.test(addr);
  if (!loopback) return false;
  if (req.headers.origin !== undefined) return false;
  return !FORWARDED.some((h) => req.headers[h] !== undefined);
}

/** An `onRequest` hook that refuses anything not from inside, with `message`. */
export function insideOnly(message: string) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    if (isFromInside(req)) {
      done();
      return;
    }
    void reply.code(403).send({ error: message });
  };
}
