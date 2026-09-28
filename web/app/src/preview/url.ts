// URLs for the Preview panel. Every app has one URL, `/a/<id>/`, on the box's
// own origin: the panel frames it, full screen opens it, and sharing makes the
// same URL public.

/** A path within an app, always starting with `/`. */
export function normalisePath(path: string): string {
  const t = path.trim();
  if (t === "") return "/";
  return t.startsWith("/") ? t : `/${t}`;
}

/** The app's URL at `path`, relative to the box: `/a/<id>/<path>`. */
export function appUrl(id: string, path = "/"): string {
  return `/a/${id}/${normalisePath(path).replace(/^\/+/, "")}`;
}

/** The absolute link to hand someone, on the origin this page was loaded from. */
export function appLink(id: string, origin: string = location.origin): string {
  return `${origin}${appUrl(id, "/")}`;
}

/**
 * The command that serves an app on the owner's own machine, at full fidelity
 * (its own origin, storage, service workers): the CLI's tunnel.
 */
export function forwardCommand(port: number): string {
  return `agentbox forward ${port}`;
}
