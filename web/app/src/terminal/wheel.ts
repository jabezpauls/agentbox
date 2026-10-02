/** WheelEvent.deltaMode values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** What a wheel event asks the pane for: scroll this many lines this way. */
export interface WheelAction {
  direction: "up" | "down";
  lines: number;
}

/**
 * Turns wheel events into whole lines for herdr's `terminal.scroll`. herdr
 * decides what the lines mean for the program in the pane — its scrollback on
 * the normal screen, a wheel report when the program took the mouse (Claude
 * Code, vim with mouse=a), arrow keys on an alternate screen without one (less)
 * — exactly as its own TUI does for the wheel. A trackpad sends many small
 * pixel deltas; their fractions carry over to the next event instead of each
 * one rounding up to a line, and a change of direction drops the carry.
 */
export class WheelLines {
  private carry = 0;

  /** The action for one event, or null while the deltas add up to less than a line. */
  take(e: { deltaY: number; deltaMode: number }, rowHeight: number, rows: number): WheelAction | null {
    const delta =
      e.deltaMode === DOM_DELTA_LINE ? e.deltaY : e.deltaMode === DOM_DELTA_PAGE ? e.deltaY * rows : e.deltaY / Math.max(1, rowHeight);
    if (!Number.isFinite(delta) || delta === 0) return null;
    if (this.carry !== 0 && Math.sign(this.carry) !== Math.sign(delta)) this.carry = 0;
    this.carry += delta;
    const whole = Math.trunc(this.carry);
    if (whole === 0) return null;
    this.carry -= whole;
    return { direction: whole < 0 ? "up" : "down", lines: Math.abs(whole) };
  }

  reset(): void {
    this.carry = 0;
  }
}

/**
 * The scrollbar thumb for herdr's scrollback, as fractions of the track: the
 * history is `max` lines above a screen of `rows`, and the view sits `offset`
 * lines above live. Null when there is nothing to scroll.
 */
export function thumb(offset: number, max: number, rows: number): { top: number; height: number } | null {
  if (max <= 0 || rows <= 0) return null;
  const total = max + rows;
  const o = Math.min(Math.max(0, offset), max);
  return { top: (max - o) / total, height: rows / total };
}
