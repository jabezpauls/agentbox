/**
 * Which live terminal belongs to which pane. Each mounted cell registers a way
 * to focus itself, so surfaces outside the grid (the composer's Escape, for
 * one) can hand focus back to a terminal without reaching into xterm's
 * internals — that coupling broke every time xterm renamed a class.
 */
const focusers = new Map<string, () => void>();

export function registerTerminal(paneId: string, focus: () => void): () => void {
  focusers.set(paneId, focus);
  return () => {
    if (focusers.get(paneId) === focus) focusers.delete(paneId);
  };
}

/** Focus a pane's terminal. Returns false when that pane has no live cell. */
export function focusTerminal(paneId: string | null): boolean {
  if (!paneId) return false;
  const focus = focusers.get(paneId);
  if (!focus) return false;
  focus();
  return true;
}
