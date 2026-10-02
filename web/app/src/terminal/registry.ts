/**
 * Which live terminal belongs to which pane. Each mounted cell registers a way
 * to focus itself and to read back what it is showing, so surfaces outside the
 * grid (the composer's Escape, for one) can hand focus to a terminal without
 * reaching into xterm's internals — that coupling broke every time xterm
 * renamed a class.
 */
export interface TerminalHandle {
  focus(): void;
  /** The visible buffer as plain text, one line per row. */
  text(): string;
  /** Send bytes to the program as they are (a quick key from the compose bar). */
  send(data: string): void;
  /** Send a composed line, and Enter, in one write. */
  submit(text: string): void;
  /** An arrow key, in the form the program asked for (normal or application cursor keys). */
  arrow(dir: "A" | "B" | "C" | "D"): void;
}

const terminals = new Map<string, TerminalHandle>();

export function registerTerminal(paneId: string, handle: TerminalHandle): () => void {
  terminals.set(paneId, handle);
  return () => {
    if (terminals.get(paneId) === handle) terminals.delete(paneId);
  };
}

const composers = new Map<string, () => void>();

/** A pane's compose bar is up: keyboard focus for the pane goes to it. */
export function registerCompose(paneId: string, focus: () => void): () => void {
  composers.set(paneId, focus);
  return () => {
    if (composers.get(paneId) === focus) composers.delete(paneId);
  };
}

/**
 * Focus a pane's terminal — its compose bar, when it has one up. Returns
 * false when that pane has no live cell.
 */
export function focusTerminal(paneId: string | null): boolean {
  if (!paneId) return false;
  const handle = terminals.get(paneId);
  if (!handle) return false;
  const compose = composers.get(paneId);
  if (compose) compose();
  else handle.focus();
  return true;
}

/** The live terminal of a pane, for the compose bar. */
export function terminalHandle(paneId: string): TerminalHandle | null {
  return terminals.get(paneId) ?? null;
}

/** What a pane's terminal currently shows, or null when it has no live cell. */
export function terminalText(paneId: string): string | null {
  return terminals.get(paneId)?.text() ?? null;
}

/**
 * A read-only introspection hook on `window`. The end-to-end tests drive the
 * production build of the app through the real bridge, so this deliberately
 * ships: a test needs to assert on what a terminal rendered, and xterm's canvas
 * has no DOM text to read. It exposes nothing a page script could not already
 * reach, and it cannot write to a terminal.
 */
if (typeof window !== "undefined") {
  (window as unknown as { __workbench?: unknown }).__workbench = {
    termText: terminalText,
    paneIds: () => [...terminals.keys()],
  };
}
