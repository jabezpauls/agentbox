import { describe, expect, it } from "vitest";
import { Predictor, type Screen } from "./predict.ts";

/** A one-row-at-a-time fake terminal: what the server has echoed so far. */
class FakeScreen implements Screen {
  cols = 20;
  cursorX: number;
  cursorY = 0;
  alt = false;
  rows: string[][] = [[], []];
  constructor(prompt: string) {
    this.rows = [Array.from({ length: this.cols }, (_, i) => prompt[i] ?? " "), Array(this.cols).fill(" ")];
    this.cursorX = prompt.length;
  }
  cell(x: number, y: number): string {
    return this.rows[y]![x]!;
  }
  /** The program echoes `text` at the cursor, as a shell at the end of its line does. */
  echo(text: string): void {
    for (const ch of text) this.rows[this.cursorY]![this.cursorX++] = ch;
  }
  /** `\b \b`, a shell's echo of a backspace. */
  rubout(): void {
    this.rows[this.cursorY]![--this.cursorX] = " ";
  }
  line(): string {
    return this.rows[this.cursorY]!.join("").trimEnd();
  }
}

function setup(prompt = "$ ") {
  const screen = new FakeScreen(prompt);
  let now = 0;
  const p = new Predictor(() => screen, { now: () => now, timeoutMs: () => 500 });
  const shown = () => {
    const o = p.overlay();
    const row = [...screen.rows[screen.cursorY]!];
    for (const c of o.cells) row[c.x] = c.ch;
    return { text: row.join("").trimEnd(), cursor: o.cursor?.x ?? null };
  };
  return { screen, p, shown, advance: (ms: number) => (now += ms) };
}

/** Type `text`, echo its first character, and settle: the epoch is now trusted. */
function trust(t: ReturnType<typeof setup>, text: string) {
  t.p.input(text[0]!);
  t.screen.echo(text[0]!);
  t.p.update();
  for (const ch of text.slice(1)) t.p.input(ch);
}

describe("Predictor", () => {
  it("keeps a new line's guesses hidden until one is confirmed, then shows the rest at once", () => {
    const t = setup();
    t.p.input("l");
    expect(t.p.overlay().cells).toEqual([]); // untrusted: could be a password prompt
    t.screen.echo("l");
    t.p.update();
    expect(t.p.pending).toBe(0);
    t.p.input("s");
    t.p.input(" ");
    t.p.input("-");
    expect(t.shown()).toEqual({ text: "$ ls -", cursor: 6 });
    expect(t.p.overlay().cells.map((c) => c.ch)).toEqual(["s", "-"]); // the space is blank already
  });

  it("drops each guess as its echo lands, and paints nothing once all are confirmed", () => {
    const t = setup();
    trust(t, "echo");
    expect(t.p.pending).toBe(3);
    t.screen.echo("ch");
    t.p.update();
    expect(t.p.pending).toBe(1);
    expect(t.p.overlay().cells).toEqual([{ x: 5, y: 0, ch: "o" }]);
    t.screen.echo("o");
    t.p.update();
    expect(t.p.pending).toBe(0);
    expect(t.p.overlay()).toEqual({ cells: [], cursor: null });
  });

  it("waits while the screen still shows the line as it was", () => {
    const t = setup();
    trust(t, "ab");
    t.p.update(); // some unrelated output; the line is unchanged
    expect(t.p.pending).toBe(1);
    expect(t.shown().text).toBe("$ ab");
  });

  it("throws every guess away when the echo differs from it", () => {
    const t = setup();
    trust(t, "abc");
    t.screen.echo("X"); // the program drew something else
    t.p.update();
    expect(t.p.pending).toBe(0);
    expect(t.shown()).toEqual({ text: "$ aX", cursor: null });
    // And the next guess starts untrusted again.
    t.p.input("d");
    expect(t.p.overlay().cells).toEqual([]);
  });

  it("never shows anything typed at a prompt that does not echo, like a password", () => {
    const t = setup("Password: ");
    for (const ch of "hunter2") {
      t.p.input(ch);
      t.p.update();
      expect(t.p.overlay().cells).toEqual([]);
    }
    t.advance(600);
    t.p.tick();
    expect(t.p.pending).toBe(0);
  });

  it("gives up on guesses whose echo is overdue", () => {
    const t = setup();
    trust(t, "abc");
    expect(t.p.pending).toBe(2);
    t.advance(499);
    t.p.tick();
    expect(t.p.pending).toBe(2);
    t.advance(2);
    t.p.tick();
    expect(t.p.pending).toBe(0);
    expect(t.shown().text).toBe("$ a");
  });

  it("predicts a backspace over what was typed, but not into the prompt", () => {
    const t = setup();
    trust(t, "ab");
    t.p.input("\x7f");
    // The unechoed "b" is rubbed out again: the screen already looks right.
    expect(t.shown()).toEqual({ text: "$ a", cursor: null });
    t.screen.echo("b");
    t.screen.rubout();
    t.p.update();
    expect(t.p.pending).toBe(0);
    t.p.input("\x7f");
    expect(t.shown()).toEqual({ text: "$", cursor: 2 });
    t.screen.rubout();
    t.p.update();
    t.p.input("\x7f"); // at the start of what was typed: the prompt is not ours
    expect(t.p.pending).toBe(0);
    expect(t.shown()).toEqual({ text: "$", cursor: null });
  });

  it("moves the cursor with ← and →, and inserts in the middle of what was typed", () => {
    const t = setup();
    trust(t, "ac");
    t.p.input("\x1b[D");
    expect(t.shown()).toEqual({ text: "$ ac", cursor: null }); // where the unechoed screen has it
    t.p.input("b");
    expect(t.shown()).toEqual({ text: "$ abc", cursor: 4 });
    t.p.input("\x1bOC"); // application cursor mode's →
    expect(t.shown().cursor).toBe(5);
    t.p.input("\x1b[C"); // past the end of the line: nothing to model
    expect(t.p.pending).toBe(0);
  });

  it("leaves text beyond what was typed alone, so a suggestion does not count against it", () => {
    const t = setup();
    trust(t, "g");
    t.screen.rows[0]!.splice(3, 6, ..."it log"); // fish's grey autosuggestion
    t.p.update();
    t.p.input("i");
    t.screen.echo("i");
    t.p.update();
    expect(t.p.pending).toBe(0);
  });

  it("stands aside on the alternate screen", () => {
    const t = setup();
    trust(t, "vim");
    t.screen.alt = true;
    t.p.update();
    expect(t.p.pending).toBe(0);
    t.p.input("i");
    expect(t.p.pending).toBe(0);
    expect(t.p.overlay().cells).toEqual([]);
  });

  it("ends the epoch on Enter, a control key or a paste, and when the cursor leaves the line", () => {
    for (const key of ["\r", "\x03", "\t", "pasted text"]) {
      const t = setup();
      trust(t, "ab");
      t.p.input(key);
      expect(t.p.pending).toBe(0);
      t.p.input("c");
      expect(t.p.overlay().cells).toEqual([]);
    }
    const t = setup();
    trust(t, "ab");
    t.screen.cursorY = 1;
    t.p.update();
    expect(t.p.pending).toBe(0);
  });

  it("does not guess at the last column, where the terminal decides the wrap", () => {
    const t = setup("$ ");
    trust(t, "x".repeat(17));
    expect(t.p.pending).toBe(16);
    t.p.input("y");
    expect(t.p.pending).toBe(0);
  });
});
