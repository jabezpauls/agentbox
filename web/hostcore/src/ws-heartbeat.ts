/**
 * How often a browser-facing socket is pinged. The public path drops a
 * WebSocket that carries nothing for about two minutes (measured: an idle
 * /ws/events through Cloudflare closed with 1006 at ~125 s; Cloudflare's own
 * limit is 100 s), so a quiet terminal would lose its socket, show
 * "Reconnecting…" and pay a fresh handshake — half a second or more through
 * the proxy — every couple of minutes. A ping well inside that keeps it open.
 */
export const HEARTBEAT_MS = 30_000;

/** The slice of a `ws` socket the heartbeat needs; keeps it testable. */
export interface Pingable {
  readonly readyState: number;
  readonly OPEN: number;
  ping(): void;
  terminate(): void;
  on(event: "pong" | "close", listener: () => void): unknown;
}

/**
 * Ping `socket` every `intervalMs` while it is open, and end it when a whole
 * interval passes with no pong: a peer that went away without a close (a
 * laptop lid, a dropped network) is noticed rather than held forever.
 * Returns a stop function; closing the socket stops it too.
 */
export function heartbeat(socket: Pingable, intervalMs = HEARTBEAT_MS): () => void {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      // Closing underneath us; the close handler stops the timer.
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  socket.on("close", stop);
  return stop;
}
