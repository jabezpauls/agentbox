import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { EditorClientMessage, EditorOpenResult, EditorServerMessage } from "@workbench/shared";

interface Editor {
  socket: WebSocket;
  version: string;
  connectedAt: number;
  focusedAt: number;
  pending: Map<string, (r: EditorOpenResult) => void>;
}

/** How long an editor has to say it opened a file. */
const ACK_MS = 5000;

/**
 * The bridge's end of the editor channel. Each running VS Code window (one
 * extension host per browser tab in code-server) holds a socket; "Open in
 * editor" goes to the one focused most recently, else the newest.
 */
export class EditorChannel {
  private readonly editors = new Set<Editor>();
  private readonly waiters = new Set<() => void>();

  constructor(private readonly ackMs = ACK_MS) {}

  get connected(): number {
    return [...this.editors].filter((e) => e.version !== "").length;
  }

  /** Take over a freshly upgraded socket from the extension. */
  attach(socket: WebSocket): void {
    const editor: Editor = { socket, version: "", connectedAt: Date.now(), focusedAt: 0, pending: new Map() };
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
        if (m.focused) editor.focusedAt = Date.now();
        for (const w of this.waiters) w();
      } else if (m.type === "focus") {
        if (m.focused) editor.focusedAt = Date.now();
      } else if (m.type === "opened" && typeof m.id === "string") {
        const done = editor.pending.get(m.id);
        editor.pending.delete(m.id);
        done?.(m.ok ? { delivered: true } : { delivered: false, error: String(m.error ?? "the editor could not open it") });
      }
    });
    socket.on("close", () => {
      this.editors.delete(editor);
      for (const done of editor.pending.values()) done({ delivered: false, error: "the editor went away" });
      editor.pending.clear();
    });
  }

  /** The editor to send to: focused most recently, else connected most recently. */
  private pick(): Editor | null {
    let best: Editor | null = null;
    for (const e of this.editors) {
      if (e.version === "" || e.socket.readyState !== e.socket.OPEN) continue;
      if (!best || e.focusedAt > best.focusedAt || (e.focusedAt === best.focusedAt && e.connectedAt > best.connectedAt)) best = e;
    }
    return best;
  }

  /** Resolve once an editor has said hello, or after `ms`. */
  private waitForEditor(ms: number): Promise<Editor | null> {
    const now = this.pick();
    if (now || ms <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (): void => {
        const e = this.pick();
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
   * editor up to show this very file — is given that long to connect.
   */
  async open(path: string, opts: { line?: number; column?: number; waitMs?: number } = {}): Promise<EditorOpenResult> {
    const editor = await this.waitForEditor(opts.waitMs ?? 0);
    if (!editor) return { delivered: false, error: "no editor is open" };
    const id = randomBytes(6).toString("hex");
    const msg: EditorServerMessage = { type: "open", id, path };
    if (opts.line !== undefined) msg.line = opts.line;
    if (opts.column !== undefined) msg.column = opts.column;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        editor.pending.delete(id);
        resolve({ delivered: false, error: "the editor did not answer" });
      }, this.ackMs);
      editor.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      editor.socket.send(JSON.stringify(msg));
    });
  }

  close(): void {
    for (const e of this.editors) e.socket.close(1001, "bridge shutting down");
  }
}
