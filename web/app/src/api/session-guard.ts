// The gate in front of the app answers a request whose session has ended — it
// idled out, it was signed out from another device, the password changed —
// with a 401 carrying `X-Agentbox-Login`. A page load would have been sent to
// sign in already; a script's request cannot be redirected, so the app does it
// here, once, and comes back to the same place afterwards.

/** The sign-in page, returning to where the user was. */
export function loginUrl(loc: Pick<Location, "pathname" | "search">): string {
  return `/login?next=${encodeURIComponent(`${loc.pathname}${loc.search}`)}`;
}

/** True for the gate's "sign in first" answer, as opposed to any other 401. */
export function isSignInRequired(res: Response): boolean {
  return res.status === 401 && res.headers.get("x-agentbox-login") !== null;
}

/**
 * Wrap `fetch` so the first "sign in first" answer sends the page to sign in,
 * and check the session whenever the tab comes back into view — a live
 * terminal socket that dropped says nothing about why.
 */
export function installSessionGuard(win: Window & typeof globalThis = window): void {
  const original = win.fetch.bind(win);
  let leaving = false;
  win.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    if (!leaving && isSignInRequired(res)) {
      leaving = true;
      win.location.assign(loginUrl(win.location));
    }
    return res;
  };
  win.document.addEventListener("visibilitychange", () => {
    if (win.document.visibilityState !== "visible") return;
    win.fetch("/_gate/session", { headers: { accept: "application/json" } }).catch(() => {});
  });
}
