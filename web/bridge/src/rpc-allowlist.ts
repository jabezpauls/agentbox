const EXACT = new Set(["ping", "session.snapshot", "notification.show"]);
const PREFIXES = ["workspace.", "worktree.", "tab.", "pane.", "agent.", "layout."];

// The pane graphics channel is a raw framebuffer relay, not a lifecycle RPC; it
// must never reach herdr through this forwarder. Deny the whole subtree — both
// the bare `pane.graphics` segment and any `pane.graphics.*` beneath it.
function isGraphics(method: string): boolean {
  return method === "pane.graphics" || method.startsWith("pane.graphics.");
}

export function isAllowed(method: string): boolean {
  if (EXACT.has(method)) return true;
  if (isGraphics(method)) return false;
  return PREFIXES.some(
    (p) => method.startsWith(p) && method.length > p.length && /^[a-z_.]+$/.test(method),
  );
}
