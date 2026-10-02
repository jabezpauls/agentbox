/**
 * Predictive local echo, after mosh. Through the public proxy every keystroke
 * waits a round trip (~125 ms) for its echo, so typing feels like wading. The
 * keys still go to the program at once and untouched; this only *guesses* what
 * the echo will paint — printable characters, backspace, ← and → on the
 * cursor's line — so an overlay can show the guess until the server's own
 * output confirms it, or contradicts it and the guess is thrown away.
 *
 * It never writes to the terminal. It reads the screen (server truth, as xterm
 * has parsed it) through `Screen`, and hands out what to paint over it.
 *
 * Safety, as mosh does it: each line is an *epoch*, and an epoch's guesses
 * stay hidden until one of them has been confirmed. A password prompt never
 * echoes, so nothing typed at it is ever shown; nor is anything after an Enter
 * until the new line proves it echoes. Anything it cannot model (Enter, Tab,
 * control keys, a paste, the cursor leaving the line, a full-screen program)
 * ends the epoch.
 */

export interface Screen {
  cols: number;
  cursorX: number;
  /** The cursor's row in the viewport. */
  cursorY: number;
  /** The alternate screen is up: a full-screen program, which draws its own echo (if any). */
  alt: boolean;
  /** The character in a cell, " " when blank. */
  cell(x: number, y: number): string;
}

export interface Overlay {
  /** Guessed cells that differ from what the screen shows now. */
  cells: { x: number; y: number; ch: string }[];
  /** Where the cursor will be, when that is not where it is. */
  cursor: { x: number; y: number } | null;
}

export interface PredictorOptions {
  now?: () => number;
  /** How long a guess may wait for its echo before it is dropped. */
  timeoutMs?: () => number;
}

/** One keystroke's guess: the line as it will look over [lo, hi), and the cursor. */
interface Edit {
  line: string[];
  cursor: number;
  lo: number;
  hi: number;
  at: number;
}

interface Epoch {
  y: number;
  /** Leftmost column the guesses may reach: where typing began. */
  min: number;
  /** One past the last character typed in this epoch. */
  max: number;
  /** Rightmost column any guess has touched (a backspace blanks one past max). */
  hi: number;
  /** One of this epoch's guesses was confirmed: the line echoes. */
  trusted: boolean;
}

const EMPTY: Overlay = { cells: [], cursor: null };

/** A key a guess can be made for: one printable, narrow character. */
function printable(data: string): boolean {
  if (data.length !== 1) return false;
  const c = data.charCodeAt(0);
  return (c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c < 0x1100);
}

export class Predictor {
  private epoch: Epoch | null = null;
  /** The screen's line and cursor when the pending guesses began. */
  private base: { line: string[]; cursor: number } | null = null;
  private work: string[] = [];
  private cursor = 0;
  private edits: Edit[] = [];
  /** The screen shows neither the line as it was nor any guess: show none. */
  private glitch = false;
  private readonly now: () => number;
  private readonly timeoutMs: () => number;

  constructor(
    private readonly screen: () => Screen,
    opts: PredictorOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.timeoutMs = opts.timeoutMs ?? (() => 1000);
  }

  /** Guesses waiting for their echo. */
  get pending(): number {
    return this.edits.length;
  }

  /** Forget everything: the next keystroke starts a fresh, untrusted epoch. */
  reset(): void {
    this.epoch = null;
    this.base = null;
    this.edits = [];
    this.glitch = false;
  }

  /** A keystroke the user sent (exactly what went to the program). */
  input(data: string): void {
    const s = this.screen();
    if (s.alt) return this.reset();
    if (this.epoch && this.epoch.y !== s.cursorY && this.edits.length === 0) this.reset();
    if (printable(data)) return this.type(s, data);
    if (data === "\x7f" || data === "\b") return this.backspace(s);
    if (data === "\x1b[D" || data === "\x1bOD") return this.move(s, -1);
    if (data === "\x1b[C" || data === "\x1bOC") return this.move(s, 1);
    this.reset();
  }

  private begin(s: Screen): Epoch {
    if (!this.epoch) this.epoch = { y: s.cursorY, min: s.cursorX, max: s.cursorX, hi: s.cursorX, trusted: false };
    if (this.edits.length === 0) {
      const line: string[] = [];
      for (let x = 0; x < s.cols; x++) line.push(s.cell(x, this.epoch.y));
      this.base = { line, cursor: s.cursorX };
      this.work = [...line];
      this.cursor = s.cursorX;
    }
    return this.epoch;
  }

  private push(e: Epoch): void {
    this.edits.push({ line: [...this.work], cursor: this.cursor, lo: e.min, hi: e.hi, at: this.now() });
  }

  private type(s: Screen, ch: string): void {
    const e = this.begin(s);
    // The last column wraps, and wrapping is the terminal's to decide.
    if (this.cursor >= s.cols - 1 || e.max >= s.cols - 1) return this.reset();
    if (this.cursor < e.max) {
      // Inserting inside what was typed: the rest of it moves right.
      // Whatever lies beyond it (a suggestion, a right prompt) stays put.
      this.work.splice(this.cursor, 0, ch);
      this.work.splice(e.max + 1, 1);
      e.max += 1;
    } else {
      this.work[this.cursor] = ch;
      e.max = this.cursor + 1;
    }
    this.cursor += 1;
    e.hi = Math.max(e.hi, e.max);
    this.push(e);
  }

  private backspace(s: Screen): void {
    const e = this.begin(s);
    if (this.cursor <= e.min) return this.reset();
    // What was typed after the cursor closes up, and its last cell clears.
    this.work.splice(this.cursor - 1, 1);
    this.work.splice(e.max - 1, 0, " ");
    this.work.length = s.cols;
    e.max -= 1;
    this.cursor -= 1;
    this.push(e);
  }

  private move(s: Screen, by: -1 | 1): void {
    const e = this.begin(s);
    const to = this.cursor + by;
    if (to < e.min || to > e.max) return this.reset();
    this.cursor = to;
    this.push(e);
  }

  private matches(s: Screen, line: string[], cursor: number, lo: number, hi: number): boolean {
    if (s.cursorX !== cursor) return false;
    for (let x = lo; x < hi; x++) if (s.cell(x, this.epoch!.y) !== line[x]) return false;
    return true;
  }

  /**
   * The screen has taken more of the server's output: confirm the guesses it
   * now shows, and wait on those it does not show yet. If it shows something
   * else, the guesses go out of sight at once; the screen may be part-way
   * through a redraw (herdr's frames can split one), so they are only dropped
   * if it has not come right by the time the echo is overdue (`tick`).
   */
  update(): void {
    const s = this.screen();
    if (s.alt) return this.reset();
    const e = this.epoch;
    if (!e) return;
    if (this.edits.length === 0) {
      if (s.cursorY !== e.y) this.reset();
      return;
    }
    this.glitch = true;
    if (s.cursorY !== e.y) return;
    for (let i = this.edits.length - 1; i >= 0; i--) {
      const ed = this.edits[i]!;
      if (this.matches(s, ed.line, ed.cursor, ed.lo, ed.hi)) {
        e.trusted = true;
        this.glitch = false;
        this.edits = this.edits.slice(i + 1);
        if (this.edits.length === 0) this.base = null;
        else this.base = { line: [...ed.line], cursor: ed.cursor };
        return;
      }
    }
    const last = this.edits[this.edits.length - 1]!;
    // The line as it was: no echo yet.
    if (this.base && this.matches(s, this.base.line, this.base.cursor, last.lo, last.hi)) this.glitch = false;
  }

  /** Drop guesses whose echo is overdue: the line may not echo at all. */
  tick(): void {
    const first = this.edits[0];
    if (first && this.now() - first.at > this.timeoutMs()) this.reset();
  }

  /** What to paint over the screen now. */
  overlay(): Overlay {
    const e = this.epoch;
    const last = this.edits[this.edits.length - 1];
    if (!e || !last || !e.trusted || this.glitch) return EMPTY;
    const s = this.screen();
    if (s.alt || s.cursorY !== e.y) return EMPTY;
    const cells: Overlay["cells"] = [];
    for (let x = last.lo; x < last.hi; x++) {
      const ch = last.line[x]!;
      if (s.cell(x, e.y) !== ch) cells.push({ x, y: e.y, ch });
    }
    const cursor = s.cursorX !== last.cursor ? { x: last.cursor, y: e.y } : null;
    return cells.length || cursor ? { cells, cursor } : EMPTY;
  }
}
