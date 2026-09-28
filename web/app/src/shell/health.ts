import { create } from "zustand";
import { getHealth } from "../api/client.ts";
import { errorText } from "../api/http.ts";
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
      useHealthState.setState({ error: errorText(err, "The box did not answer.") });
      timer = setTimeout(() => void loadHealth(), retryDelay(attempt));
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** For tests: forget any retry in flight. */
export function resetHealth(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  attempt = 0;
  inflight = null;
  useHealthState.setState({ error: null });
}
