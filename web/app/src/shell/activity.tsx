import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Whether the surface a component lives in is the one showing. Surfaces are
 * kept mounted when you move away — the editor and the terminals must stay
 * live — so anything that costs something while nobody looks (polling above
 * all) asks this and stops. Sockets stay open regardless.
 */
export const SurfaceActiveContext = createContext(true);

export function useSurfaceActive(): boolean {
  return useContext(SurfaceActiveContext);
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** Whether the browser tab itself is in view. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/**
 * Run `fn` now and every `ms` while the surface is showing and the tab is in
 * view; pause otherwise, and run again straight away on coming back, so what
 * you return to is current. A run never overlaps the previous one. `refresh`
 * runs it now, out of turn (after an action that changed what it reads).
 */
export function usePolling(fn: () => Promise<unknown> | unknown, ms: number, enabled = true): { refresh(): void } {
  const active = useSurfaceActive();
  const visible = usePageVisible();
  const live = enabled && active && visible;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const running = useRef(false);
  const again = useRef(false);

  const run = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      await fnRef.current();
    } catch {
      // The caller shows its own error state; a failed poll just waits for the next.
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        void run();
      }
    }
  }, []);

  useEffect(() => {
    if (!live) return;
    void run();
    const id = setInterval(() => void run(), ms);
    return () => clearInterval(id);
  }, [live, ms, run]);

  return { refresh: () => void run() };
}

/**
 * Call `onActivate` whenever the surface comes into view, including when it
 * mounts in view. Surfaces use it to put focus somewhere useful.
 */
export function useOnActivate(onActivate: () => void): void {
  const active = useSurfaceActive();
  const ref = useRef(onActivate);
  ref.current = onActivate;
  useEffect(() => {
    if (active) ref.current();
  }, [active]);
}

/**
 * Run `fn` when the surface goes out of view. Surface-local dialogs close
 * with it — above all ones holding a typed password — rather than wait,
 * hidden and inert, for someone to come back to them.
 */
export function useWhenHidden(fn: () => void): void {
  const active = useSurfaceActive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) ref.current();
  }, [active]);
}

/**
 * A modal that is open where you can see it. One left open inside a surface
 * you moved away from is inert and hidden, and does not count.
 */
export function openModal(): Element | null {
  if (typeof document === "undefined") return null;
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).find((el) => !el.closest("[inert]")) ?? null;
}

/**
 * Give a surface that just came into view the keyboard — but only if nothing
 * else has taken it meanwhile: a palette or dialog opened on the way, or a
 * field the user is already in. Focus left on the rail, on nothing, or inside
 * the surface just hidden is fair to move.
 */
export function focusOnArrival(focus: () => void): void {
  requestAnimationFrame(() => {
    if (openModal()) return;
    const at = document.activeElement as HTMLElement | null;
    if (!at || at === document.body || at.closest(".rail, .bottombar, [inert]")) focus();
  });
}
