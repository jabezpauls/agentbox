import { create } from "zustand";
import { getHealth, RpcError } from "../api/client.ts";
import { useApp } from "../store/app.ts";

/**
 * `GET /api/health` — where the roots are, what the box can do — which Files
 * and others need before they can do anything. Read at load and, when that
 * fails (the bridge restarting, a tunnel blip), again with backoff, and again
 * whenever the events socket comes back. Surfaces that wait on it show the
 * failure with a Retry instead of waiting for ever.
 */
export const useHealthState = create<{ error: string | null }>(() => ({ error: null }));

const MAX_DELAY_MS = 30_000;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

/** Why the box could not be read, in words — never "/api/health → 502". */
export function healthErrorText(err: unknown): string {
  if (err instanceof RpcError) {
    if (err.status >= 500) return "The box is not answering right now — it may be restarting.";
    return "The box turned the request down.";
  }
  return "The box could not be reached. Check the connection.";
}

export function retryDelay(n: number): number {
  return Math.min(MAX_DELAY_MS, 1000 * 2 ** Math.max(0, n - 1));
}

export function loadHealth(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inflight) return inflight;
  inflight = getHealth()
    .then((h) => {
      attempt = 0;
      useApp.getState().setHealth(h);
      useHealthState.setState({ error: null });
    })
    .catch((err: unknown) => {
      attempt += 1;
      useHealthState.setState({ error: healthErrorText(err) });
      timer = setTimeout(() => void loadHealth(), retryDelay(attempt));
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Whether the box has stopped answering: the events socket dropped and has
 * not come back. Surfaces say so instead of showing what they last knew as
 * if it were current ("Nothing is listening", "No agents working").
 */
export const useReach = create<{ lost: boolean }>(() => ({ lost: false }));

useApp.subscribe((s, prev) => {
  if (s.status === prev.status) return;
  if (s.status === "open") useReach.setState({ lost: false });
  else if (s.status === "closed") useReach.setState({ lost: true });
});

export function useOutOfReach(): boolean {
  return useReach((s) => s.lost);
}

/** For tests: forget any retry in flight. */
export function resetHealth(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  attempt = 0;
  inflight = null;
  useHealthState.setState({ error: null });
}
