import { WebSocket } from "ws";

/**
 * WebSocket keepalive for the long-lived sockets (terminals, tunnels): a ping
 * every so often keeps Cloudflare, which drops a socket idle for 100 s, from
 * cutting a quiet session; and a socket that has stopped answering — a laptop
 * that slept, a network that changed — is noticed rather than left looking
 * connected for ever, since TCP alone may not say so for many minutes.
 */

/** How often to ping. */
export const PING_MS = 25_000;
/** Pings left unanswered in a row before the socket counts as dead. */
export const MISSED_PONGS = 2;

/**
 * Ping `ws` every `everyMs`; a pong, or any message, shows it is alive. When
 * `missed` pings in a row go unanswered, `onDead` is called once. Returns a
 * function that stops it.
 */
export function keepAlive(ws: WebSocket, onDead: () => void, everyMs = PING_MS, missed = MISSED_PONGS): () => void {
  let unanswered = 0;
  const alive = (): void => {
    unanswered = 0;
  };
  const stop = (): void => {
    clearInterval(timer);
    ws.off("pong", alive);
    ws.off("message", alive);
  };
  ws.on("pong", alive);
  ws.on("message", alive);
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (unanswered >= missed) {
      stop();
      onDead();
      return;
    }
    unanswered += 1;
    ws.ping();
  }, everyMs);
  timer.unref();
  return stop;
}
