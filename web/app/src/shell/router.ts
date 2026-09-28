import { create } from "zustand";
import { parseRoute, pathFor, type Route, type SurfaceId } from "./routes.ts";

/**
 * Client-side routing over the History API. The route is the single source
 * of truth for which surface is showing; every change goes through the
 * address bar, so reload, back and forward all land where they should.
 *
 * Surfaces are kept, not rebuilt: `mounted` lists every surface visited so
 * far, and the shell keeps each of those alive (hidden when not current).
 * `last` remembers where each surface was left, so the rail takes you back to
 * the folder you were in rather than to the top of Files.
 */
export interface RouterState {
  route: Route;
  last: Partial<Record<SurfaceId, Route>>;
  mounted: SurfaceId[];
  /** Go to a route; `replace` rewrites the current history entry instead of adding one. */
  navigate(to: Route, opts?: { replace?: boolean }): void;
  /** Go to a surface, where it was last left. */
  go(surface: SurfaceId): void;
  /** Mount a surface without showing it (the editor, warming up for "Open in editor"). */
  mount(surface: SurfaceId): void;
  /** Take the route from the address bar (initial load, back, forward). */
  sync(): void;
}

function fromLocation(): Route {
  if (typeof window === "undefined") return { surface: "home" };
  return parseRoute(window.location.pathname, window.location.search);
}

/** The landing route for a surface nobody has visited yet. */
export function defaultRoute(surface: SurfaceId): Route {
  switch (surface) {
    case "files":
      return { surface: "files", path: "" };
    case "system":
      return { surface: "system", view: "overview" };
    case "settings":
      return { surface: "settings", section: "account" };
    default:
      return { surface } as Route;
  }
}

function withMounted(mounted: SurfaceId[], s: SurfaceId): SurfaceId[] {
  return mounted.includes(s) ? mounted : [...mounted, s];
}

const initial = fromLocation();

export const useRouter = create<RouterState>((set, get) => ({
  route: initial,
  last: { [initial.surface]: initial },
  mounted: [initial.surface],

  navigate(to, opts) {
    const path = pathFor(to);
    const current = `${window.location.pathname}${window.location.search}`;
    if (opts?.replace || path === current) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    set((s) => ({
      route: to,
      last: { ...s.last, [to.surface]: to },
      mounted: withMounted(s.mounted, to.surface),
    }));
  },

  go(surface) {
    const { route, last, navigate } = get();
    if (route.surface === surface) return;
    navigate(last[surface] ?? defaultRoute(surface));
  },

  mount(surface) {
    set((s) => ({ mounted: withMounted(s.mounted, surface) }));
  },

  sync() {
    const to = fromLocation();
    set((s) => ({
      route: to,
      last: { ...s.last, [to.surface]: to },
      mounted: withMounted(s.mounted, to.surface),
    }));
  },
}));

/** Follow back and forward. Returns a disposer. */
export function installRouter(win: Window = window): () => void {
  const onPop = () => useRouter.getState().sync();
  win.addEventListener("popstate", onPop);
  // Normalise what was typed (`/files/`, `/settings`) to the canonical path,
  // without adding a history entry.
  const route = useRouter.getState().route;
  const canonical = pathFor(route);
  if (`${win.location.pathname}${win.location.search}` !== canonical) win.history.replaceState(null, "", canonical);
  return () => win.removeEventListener("popstate", onPop);
}

/** Navigate from anywhere, outside React. */
export function navigate(to: Route, opts?: { replace?: boolean }): void {
  useRouter.getState().navigate(to, opts);
}
