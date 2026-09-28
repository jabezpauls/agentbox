import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { EditorClientMessage, EditorOpenResult, EditorServerMessage, EditorThemeKind } from "@workbench/shared";

interface Editor {
  socket: WebSocket;
  version: string;
  /**
   * The last sign that someone is at this window: it connected, said hello,
   * or took focus. code-server keeps a closed tab's extension host — and so
   * its socket — alive for hours, so a window that merely stays connected
   * proves nothing; one that just connected or was just focused does.
   */
  seenAt: number;
  pending: Map<string, (r: EditorOpenResult) => void>;
}

/** How long an editor has to say it opened a file. */
const ACK_MS = 5000;

/**
 * How long an open asked for `fresh` waits for a window to show a sign of
 * life — the app's own frame, just brought forward, takes focus and says so
 * — before settling for the best it already knows.
 */
const FRESH_MS = 1500;

/**
 * The bridge's end of the editor channel. Each running VS Code window (one
 * extension host per browser tab in code-server) holds a socket; "Open in
 * editor" goes to the one seen most recently — connected or focused — and a
 * window that says it is closing is dropped at once.
 *
 * The channel also carries the app's theme: each window is told the app's
 * resolved light or dark when it connects and whenever it changes, so the
 * editor is never the one light pane in a dark app.
 */
export class EditorChannel {
  private readonly editors = new Set<Editor>();
  private readonly waiters = new Set<() => void>();
  private themeKind: EditorThemeKind | null = null;
  private clock = 0;

  constructor(
    private readonly ackMs = ACK_MS,
    private readonly freshMs = FRESH_MS,
  ) {}

  get connected(): number {
    return [...this.editors].filter((e) => e.version !== "").length;
  }

  get theme(): EditorThemeKind | null {
    return this.themeKind;
  }

  /**
   * A strictly increasing stamp, so two signs of life in the same
   * millisecond still have an order.
   */
  private now(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  /** Take over a freshly upgraded socket from the extension. */
  attach(socket: WebSocket): void {
    const editor: Editor = { socket, version: "", seenAt: this.now(), pending: new Map() };
    this.editors.add(editor);
    socket.on("message", (raw: Buffer) => {
      let m: EditorClientMessage;
      try {
        m = JSON.parse(raw.toString()) as EditorClientMessage;
      } catch {
        return;
      }
      if (m.type === "hello") {
        editor.version = typeof m.version === "string" && m.version ? m.version : "unknown";
        editor.seenAt = this.now();
        if (this.themeKind) this.send(editor, { type: "theme", kind: this.themeKind });
        this.wake();
      } else if (m.type === "focus") {
        if (m.focused) {
          editor.seenAt = this.now();
          this.wake();
        }
      } else if (m.type === "opened" && typeof m.id === "string") {
        const done = editor.pending.get(m.id);
        editor.pending.delete(m.id);
        done?.(m.ok ? { delivered: true } : { delivered: false, error: String(m.error ?? "the editor could not open it") });
      } else if (m.type === "bye") {
        this.drop(editor, "the editor closed");
      }
    });
    socket.on("close", () => this.drop(editor, "the editor went away"));
  }

  private drop(editor: Editor, why: string): void {
    if (!this.editors.delete(editor)) return;
    for (const done of editor.pending.values()) done({ delivered: false, error: why });
    editor.pending.clear();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private send(editor: Editor, m: EditorServerMessage): void {
    if (editor.socket.readyState === editor.socket.OPEN) editor.socket.send(JSON.stringify(m));
  }

  /** Follow the app's theme: tell every window now, and each new one as it connects. */
  setTheme(kind: EditorThemeKind): void {
    if (this.themeKind === kind) return;
    this.themeKind = kind;
    for (const e of this.editors) if (e.version !== "") this.send(e, { type: "theme", kind });
  }

  /** The editor to send to: the one seen most recently, `since` a moment if given. */
  private pick(since = 0): Editor | null {
    let best: Editor | null = null;
    for (const e of this.editors) {
      if (e.version === "" || e.socket.readyState !== e.socket.OPEN || e.seenAt < since) continue;
      if (!best || e.seenAt > best.seenAt) best = e;
    }
    return best;
  }

  /** Resolve once an editor seen `since` then is ready, or after `ms`. */
  private waitForEditor(ms: number, since = 0): Promise<Editor | null> {
    const now = this.pick(since);
    if (now || ms <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (): void => {
        const e = this.pick(since);
        if (!e) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(e);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve(null);
      }, ms);
      this.waiters.add(done);
    });
  }

  /**
   * Ask a running editor to open `path` (at `line`, `column`, 1-based). With
   * `waitMs`, an editor that is still starting — the app just brought the
   * editor up to show this very file — is given that long to connect. With
   * `fresh`, the app has just brought its editor frame forward, which takes
   * focus: a window that shows a sign of life from now on is preferred, for
   * a moment, over one merely known — a closed tab's lingering window above
   * all.
   */
  async open(
    path: string,
    opts: { line?: number; column?: number; waitMs?: number; fresh?: boolean } = {},
  ): Promise<EditorOpenResult> {
    const asked = this.now();
    let editor: Editor | null = null;
    if (opts.fresh) editor = await this.waitForEditor(Math.min(this.freshMs, opts.waitMs ?? this.freshMs), asked);
    editor ??= await this.waitForEditor(opts.waitMs ?? 0);
    if (!editor) return { delivered: false, error: "no editor is open" };
    const id = randomBytes(6).toString("hex");
    const msg: Extract<EditorServerMessage, { type: "open" }> = { type: "open", id, path };
    if (opts.line !== undefined) msg.line = opts.line;
    if (opts.column !== undefined) msg.column = opts.column;
    const target = editor;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        target.pending.delete(id);
        resolve({ delivered: false, error: "the editor did not answer" });
      }, this.ackMs);
      target.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      target.socket.send(JSON.stringify(msg));
    });
  }

  close(): void {
    for (const e of this.editors) e.socket.close(1001, "bridge shutting down");
  }
}
