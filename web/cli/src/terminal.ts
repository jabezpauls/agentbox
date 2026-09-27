import type { InStream, OutStream } from "./context.js";
import { describeEnd, exitCodeFor, type Ended, type TtydSession } from "./ttyd.js";

/**
 * The local side of `attach` and `shell`: raw mode, the detach keys, window
 * sizes, back-pressure, and — whatever way the session ends — a terminal put
 * back the way it was found.
 */

/** `Ctrl-]`, then `q`, detaches, as telnet's escape character does. */
export const DETACH_PREFIX = 0x1d;
export const DETACH_KEYS = "Ctrl-] then q";

/**
 * Watches keystrokes for the detach sequence. `Ctrl-]` is held back until
 * the next key: `q` detaches, a second `Ctrl-]` sends one through, anything
 * else sends both.
 */
export class DetachFilter {
  private pending = false;

  push(chunk: Buffer): { forward: Buffer; detach: boolean } {
    if (!this.pending && !chunk.includes(DETACH_PREFIX)) return { forward: chunk, detach: false };
    const out: number[] = [];
    for (const b of chunk) {
      if (this.pending) {
        this.pending = false;
        if (b === 0x71 || b === 0x51) return { forward: Buffer.from(out), detach: true };
        if (b === DETACH_PREFIX) out.push(DETACH_PREFIX);
        else out.push(DETACH_PREFIX, b);
        continue;
      }
      if (b === DETACH_PREFIX) this.pending = true;
      else out.push(b);
    }
    return { forward: Buffer.from(out), detach: false };
  }
}

const ALT_SCREENS = [1049, 1047, 47];
const MOUSE_MODES = [1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016];
const ESC = "\x1b";

/**
 * Follows the terminal modes the remote program switches, by reading its
 * output, so that leaving — detaching mid-draw, a dropped connection — can
 * switch back exactly those: the alternate screen, mouse reporting,
 * bracketed paste, focus events, application cursor keys, a hidden cursor,
 * the keypad, and kitty's keyboard protocol. A mode the program never touched
 * is left alone (resetting the alternate screen when it is not active would
 * move the cursor, for one).
 */
export class ModeTracker {
  private readonly modes = new Map<number, boolean>();
  private keypad = false;
  private kittyPushes = 0;
  private modifyOtherKeys = false;
  private carry = "";

  observe(chunk: Buffer): void {
    // latin1 keeps every byte as one character, so offsets are byte offsets.
    const s = this.carry + chunk.toString("latin1");
    this.carry = "";
    const re = /\x1b(?:\[\?([\d;]*)([hl])|\[>(\d*)u|\[<(\d*)u|\[>4;?(\d*)m|([=>]))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[2] !== undefined) {
        const on = m[2] === "h";
        for (const n of (m[1] ?? "").split(";")) if (n !== "") this.modes.set(Number(n), on);
      } else if (m[3] !== undefined) {
        this.kittyPushes += 1;
      } else if (m[4] !== undefined) {
        this.kittyPushes = Math.max(0, this.kittyPushes - (m[4] === "" ? 1 : Number(m[4])));
      } else if (m[5] !== undefined) {
        this.modifyOtherKeys = m[5] !== "" && m[5] !== "0";
      } else if (m[6] !== undefined) {
        this.keypad = m[6] === "=";
      }
    }
    // A sequence cut in two by the chunk boundary: keep its start for next time.
    const last = s.lastIndexOf(ESC);
    if (last !== -1 && s.length - last < 32 && /^\x1b(\[([?<>]\d*(;\d*)?)?)?$/.test(s.slice(last))) this.carry = s.slice(last);
  }

  /** What to write to undo every mode the program left switched on. */
  restoreSequence(): string {
    let out = "";
    for (const n of ALT_SCREENS) if (this.modes.get(n)) out += `${ESC}[?${n}l`;
    for (const n of MOUSE_MODES) if (this.modes.get(n)) out += `${ESC}[?${n}l`;
    if (this.modes.get(2004)) out += `${ESC}[?2004l`;
    if (this.modes.get(1004)) out += `${ESC}[?1004l`;
    if (this.modes.get(1)) out += `${ESC}[?1l`;
    if (this.modes.get(25) === false) out += `${ESC}[?25h`;
    if (this.keypad) out += `${ESC}>`;
    if (this.kittyPushes > 0) out += `${ESC}[<${this.kittyPushes}u`;
    if (this.modifyOtherKeys) out += `${ESC}[>4m`;
    // Colours and attributes, always: a program cut off mid-draw leaves them set.
    return `${out}${ESC}[0m`;
  }
}

/**
 * Raw mode, entered once and restored exactly once — on detach, on the remote
 * end closing, on an error, on a signal, or on `process.exit` from anywhere.
 */
export class TerminalGuard {
  private active = false;
  readonly modes = new ModeTracker();

  constructor(
    private readonly stdin: InStream,
    private readonly stdout: OutStream,
  ) {}

  get raw(): boolean {
    return this.active && this.stdin.isTTY === true;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    if (this.stdin.isTTY && this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.resume();
  }

  /** Output from the remote program: watched for the modes it switches. */
  observe(chunk: Buffer): void {
    this.modes.observe(chunk);
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    try {
      if (this.stdout.isTTY) this.stdout.write(this.modes.restoreSequence());
    } catch {
      // A closed terminal has nothing left to restore.
    }
    try {
      if (this.stdin.isTTY && this.stdin.setRawMode) this.stdin.setRawMode(false);
    } catch {
      // As above.
    }
    this.stdin.pause();
  }
}

/** The bits of `process` the guard hooks, so a test can stand in for it. */
export interface ProcessHooks {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export const EXIT_SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };

/**
 * Restore the terminal on every way out of the process: `exit` (which also
 * covers `process.exit` called anywhere), the signals that end a program, and
 * an exception nothing caught. `onSignal` decides what a signal then does
 * (usually: exit 128 + n), and `onCrash` what an uncaught exception does,
 * once the terminal is sane enough to show it. Returns a function that
 * removes the hooks.
 */
export function guardProcess(
  guard: TerminalGuard,
  proc: ProcessHooks,
  onSignal: (signal: string, code: number) => void,
  onCrash: (err: unknown) => void,
): () => void {
  const handlers: Array<[string, (...args: unknown[]) => void]> = [["exit", () => guard.restore()]];
  for (const [sig, n] of Object.entries(EXIT_SIGNALS)) {
    handlers.push([
      sig,
      () => {
        guard.restore();
        onSignal(sig, 128 + n);
      },
    ]);
  }
  handlers.push([
    "uncaughtException",
    (err: unknown) => {
      guard.restore();
      onCrash(err);
    },
  ]);
  for (const [ev, fn] of handlers) proc.on(ev, fn);
  return () => {
    for (const [ev, fn] of handlers) proc.off(ev, fn);
  };
}

/** The window size to start at: the terminal's, or 80×24 when there is none. */
export function windowSize(stdout: OutStream, env: NodeJS.ProcessEnv = {}): { columns: number; rows: number } {
  const columns = stdout.columns ?? Number(env.COLUMNS);
  const rows = stdout.rows ?? Number(env.LINES);
  return {
    columns: Number.isInteger(columns) && columns > 0 ? columns : 80,
    rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
  };
}

export interface RunTerminalOptions {
  session: TtydSession;
  stdin: InStream;
  stdout: OutStream;
  stderr: OutStream;
  proc: ProcessHooks;
  env?: NodeJS.ProcessEnv;
  /** Typed into the program once the session opens (`shell --cwd`). */
  initialInput?: string;
  /** An exception nothing caught, after the terminal is restored (default: print it, exit 1). */
  onCrash?: (err: unknown) => void;
}

function defaultCrash(stderr: OutStream): (err: unknown) => void {
  return (err) => {
    stderr.write(`agentbox: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  };
}

/**
 * Join the local terminal to a ttyd session until it ends, and resolve with
 * the exit code. The terminal is restored before this resolves, whichever way
 * it ended.
 */
export function runTerminal(opts: RunTerminalOptions): Promise<number> {
  const { session, stdin, stdout, stderr, proc } = opts;
  const guard = new TerminalGuard(stdin, stdout);
  const filter = new DetachFilter();
  let paused = false;

  return new Promise<number>((resolve) => {
    let done = false;
    const unhook = guardProcess(
      guard,
      proc,
      (signal, code) => finish({ reason: "error", message: `interrupted (${signal})` }, code),
      opts.onCrash ?? defaultCrash(stderr),
    );

    const onInput = (chunk: Buffer | string): void => {
      const { forward, detach } = filter.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      if (forward.length) session.input(forward);
      if (detach) session.detach();
    };
    const onResize = (): void => {
      const { columns, rows } = windowSize(stdout, opts.env);
      session.resize(columns, rows);
    };
    const onDrain = (): void => {
      if (paused) {
        paused = false;
        session.resume();
      }
    };

    function finish(ended: Ended, code = exitCodeFor(ended)): void {
      if (done) return;
      done = true;
      session.dispose();
      stdin.off?.("data", onInput);
      stdout.off?.("resize", onResize);
      stdout.off?.("drain", onDrain);
      guard.restore();
      unhook();
      const message = describeEnd(ended);
      if (ended.reason === "detached") stderr.write("\r\n[detached]\r\n");
      else if (message) stderr.write(`\r\nagentbox: ${message}\r\n`);
      resolve(code);
    }

    session.on("open", () => {
      guard.enter();
      stdin.on("data", onInput);
      stdout.on?.("resize", onResize);
      stdout.on?.("drain", onDrain);
      if (opts.initialInput) session.input(Buffer.from(opts.initialInput, "utf8"));
    });
    session.on("output", (data) => {
      guard.observe(data);
      // Flow control: when the terminal cannot keep up, ttyd stops reading
      // the program's output until it has.
      if (!stdout.write(data) && !paused) {
        paused = true;
        session.pause();
      }
    });
    session.on("close", (ended) => finish(ended));
    const { columns, rows } = windowSize(stdout, opts.env);
    session.connect(columns, rows);
  });
}
