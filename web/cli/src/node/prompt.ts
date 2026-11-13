import type { InStream, OutStream } from "../context.js";
import { CliError, EXIT } from "../errors.js";

/**
 * Questions on the machine's own terminal: a line, or a secret typed with no
 * echo. Without a terminal (a script piping answers in) each answer is the
 * next line of stdin, so nothing secret ever has to be an argument.
 */
export class Prompter {
  private buffer = "";
  private ended = false;
  private waiting: (() => void) | null = null;
  private listening = false;

  constructor(
    private readonly stdin: InStream,
    private readonly out: OutStream,
  ) {}

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.stdin.on("data", (c: Buffer | string) => {
      this.buffer += c.toString();
      this.waiting?.();
    });
    this.stdin.on("end", () => {
      this.ended = true;
      this.waiting?.();
    });
    this.stdin.resume();
  }

  private async nextLine(): Promise<string> {
    this.listen();
    for (;;) {
      const i = this.buffer.search(/\r?\n|\r/);
      if (i >= 0) {
        const line = this.buffer.slice(0, i);
        const nl = /^\r?\n|^\r/.exec(this.buffer.slice(i))?.[0].length ?? 1;
        this.buffer = this.buffer.slice(i + nl);
        return line;
      }
      if (this.ended) {
        if (this.buffer === "") throw new CliError("no answer on stdin", EXIT.USAGE);
        const line = this.buffer;
        this.buffer = "";
        return line;
      }
      await new Promise<void>((r) => (this.waiting = r));
      this.waiting = null;
    }
  }

  async line(question: string): Promise<string> {
    this.out.write(question);
    return (await this.nextLine()).trim();
  }

  /** A secret: on a terminal, read in raw mode and never echoed. */
  async secret(question: string): Promise<string> {
    this.out.write(question);
    if (!this.stdin.isTTY || !this.stdin.setRawMode) return this.nextLine();
    this.listen();
    this.stdin.setRawMode(true);
    try {
      let value = "";
      for (;;) {
        while (this.buffer.length > 0) {
          const ch = this.buffer[0] as string;
          this.buffer = this.buffer.slice(1);
          if (ch === "\r" || ch === "\n") {
            this.out.write("\n");
            return value;
          }
          if (ch === "\u0003") throw new CliError("interrupted", EXIT.INTERRUPTED);
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
        if (this.ended) throw new CliError("no answer", EXIT.USAGE);
        await new Promise<void>((r) => (this.waiting = r));
        this.waiting = null;
      }
    } finally {
      this.stdin.setRawMode(false);
    }
  }

  close(): void {
    this.stdin.pause();
  }
}
