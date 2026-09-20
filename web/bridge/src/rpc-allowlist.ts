const EXACT = new Set(["ping", "session.snapshot", "notification.show"]);
const PREFIXES = ["workspace.", "worktree.", "tab.", "pane.", "agent.", "layout."];

export function isAllowed(method: string): boolean {
  if (EXACT.has(method)) return true;
  return (
    PREFIXES.some(
      (p) => method.startsWith(p) && method.length > p.length && /^[a-z_.]+$/.test(method),
    ) && !method.startsWith("pane.graphics.")
  );
}
