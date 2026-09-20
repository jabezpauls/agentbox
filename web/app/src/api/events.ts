import type { EventsMessage } from "@workbench/shared";
import { wsUrl } from "./base.ts";

export type ConnStatus = "connecting" | "open" | "closed";

export interface EventHandlers {
  onMessage(m: EventsMessage): void;
  onStatus(s: ConnStatus): void;
}

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 5000;

/**
 * Keep a live subscription to `/ws/events`, reconnecting with capped backoff.
 * Returns a disposer that closes the socket and cancels any pending retry.
 */
export function connectEvents(handlers: EventHandlers): () => void {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = MIN_BACKOFF;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    handlers.onStatus("connecting");
    const ws = new WebSocket(wsUrl("/ws/events"));
    socket = ws;

    ws.onopen = () => {
      backoff = MIN_BACKOFF;
      handlers.onStatus("open");
    };
    ws.onmessage = (ev) => {
      let msg: EventsMessage;
      try {
        msg = JSON.parse(ev.data as string) as EventsMessage;
      } catch {
        return;
      }
      handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (disposed) return;
      handlers.onStatus("closed");
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
    ws.onerror = () => {
      // A failed connection surfaces as a close; let onclose schedule the retry.
      ws.close();
    };
  };

  open();

  return () => {
    disposed = true;
    if (retry) clearTimeout(retry);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}
