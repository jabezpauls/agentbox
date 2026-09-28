import type { OutStream } from "./context.js";
import { formatBytes, safeText } from "./format.js";

/**
 * A transfer's progress on one line of stderr, redrawn at most ten times a
 * second — and only on a terminal: piped or redirected, a transfer is quiet
 * but for errors.
 */
export class Progress {
  private last = 0;
  private done = 0;
  private readonly started: number;
  private drawn = false;

  private readonly label: string;

  constructor(
    private readonly stream: OutStream,
    label: string,
    private readonly total: number | null,
    private readonly enabled: boolean = stream.isTTY === true,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
    // A local path built from names the box gave: shown, never interpreted.
    this.label = safeText(label);
  }

  update(done: number): void {
    this.done = done;
    if (!this.enabled) return;
    const t = this.now();
    if (t - this.last < 100) return;
    this.last = t;
    this.draw();
  }

  /** The line as it stands: label, percentage, bytes, rate. */
  line(): string {
    const elapsed = Math.max(0.001, (this.now() - this.started) / 1000);
    const rate = `${formatBytes(Math.round(this.done / elapsed))}/s`;
    if (this.total === null) return `${this.label}  ${formatBytes(this.done)}  ${rate}`;
    const pct = this.total === 0 ? 100 : Math.floor((this.done / this.total) * 100);
    return `${this.label}  ${String(pct).padStart(3)}%  ${formatBytes(this.done)} of ${formatBytes(this.total)}  ${rate}`;
  }

  private draw(): void {
    // A pty may say it is 0 columns wide (not set up yet): assume 80 then,
    // and never try to fit into less than a handful.
    const cols = this.stream.columns;
    const width = cols && cols >= 20 ? cols : cols && cols > 0 ? 20 : 80;
    let text = this.line();
    if (text.length > width - 1) text = `…${text.slice(text.length - (width - 2))}`;
    this.stream.write(`\r\x1b[2K${text}`);
    this.drawn = true;
  }

  /** The final line, left on screen. */
  finish(): void {
    if (!this.enabled) return;
    this.draw();
    this.stream.write("\n");
    this.drawn = false;
  }

  /** Clear the line (an error follows). */
  abandon(): void {
    if (this.enabled && this.drawn) this.stream.write("\r\x1b[2K");
    this.drawn = false;
  }
}
