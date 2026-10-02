import type { Terminal } from "@xterm/xterm";
import type { Overlay, Screen } from "./predict.ts";

/** Below this round trip an echo is quick enough that a guess only adds flicker. */
export const PREDICT_MIN_RTT_MS = 30;

/** The predictor's view of an xterm: its active buffer, as parsed so far. */
export function xtermScreen(term: Terminal): () => Screen {
  return () => {
    const b = term.buffer.active;
    const scratch = b.getNullCell();
    return {
      cols: term.cols,
      cursorX: b.cursorX,
      cursorY: b.cursorY,
      alt: b.type === "alternate",
      cell: (x, y) => b.getLine(b.baseY + y)?.getCell(x, scratch)?.getChars() || " ",
    };
  };
}

/**
 * Paints the predictor's guesses over the terminal: a layer of its own on top
 * of xterm's screen, never bytes in xterm's buffer, so server truth is always
 * one clear() away. Each guessed cell is drawn opaque, underlined, at the
 * cell's place, which also covers the real cursor while the guess runs ahead
 * of it; a bar marks where the cursor will be.
 */
export class PredictionLayer {
  private readonly el: HTMLDivElement;
  private empty = true;

  constructor(private readonly term: Terminal) {
    this.el = document.createElement("div");
    this.el.className = "term-predict";
    this.el.setAttribute("aria-hidden", "true");
    term.element?.querySelector(".xterm-screen")?.appendChild(this.el);
  }

  render(o: Overlay): void {
    if (o.cells.length === 0 && !o.cursor) {
      if (!this.empty) this.el.replaceChildren();
      this.empty = true;
      return;
    }
    this.empty = false;
    const screen = this.el.parentElement;
    if (!screen) return;
    const w = screen.clientWidth / this.term.cols;
    const h = screen.clientHeight / this.term.rows;
    const theme = this.term.options.theme ?? {};
    const font = `${this.term.options.fontSize ?? 13}px ${this.term.options.fontFamily ?? "monospace"}`;
    const nodes: HTMLElement[] = o.cells.map((c) => {
      const s = document.createElement("span");
      s.className = "term-predict-cell";
      s.textContent = c.ch;
      Object.assign(s.style, {
        left: `${c.x * w}px`,
        top: `${c.y * h}px`,
        width: `${w}px`,
        height: `${h}px`,
        lineHeight: `${h}px`,
        font,
        color: theme.foreground ?? "",
        background: theme.background ?? "",
      });
      return s;
    });
    if (o.cursor) {
      const c = document.createElement("span");
      c.className = "term-predict-cursor";
      Object.assign(c.style, { left: `${o.cursor.x * w}px`, top: `${o.cursor.y * h}px`, height: `${h}px`, background: theme.cursor ?? theme.foreground ?? "" });
      nodes.push(c);
    }
    this.el.replaceChildren(...nodes);
  }

  dispose(): void {
    this.el.remove();
  }
}
