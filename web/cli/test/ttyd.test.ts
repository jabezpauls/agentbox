import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { cdCommand } from "../src/commands/terminal.js";
import { BoxClient } from "../src/http.js";
import { classifyCsi, DetachFilter, guardProcess, ModeTracker, runTerminal, TerminalGuard } from "../src/terminal.js";
import {
  handshakeFrame,
  inputFrame,
  parseServerFrame,
  PAUSE_FRAME,
  resizeFrame,
  RESUME_FRAME,
  TtydSession,
  type Ended,
} from "../src/ttyd.js";
import { TOKEN, capture, emit, fakeStdin, type Captured } from "./helpers.js";

describe("ttyd's framing", () => {
  it("builds the client's frames byte for byte as ttyd 1.7.7's own client does", () => {
    expect(handshakeFrame(120, 40).toString()).toBe('{"AuthToken":"","columns":120,"rows":40}');
    expect(inputFrame("ls\r")).toEqual(Buffer.from("0ls\r"));
    expect(inputFrame(Buffer.from([0x03]))).toEqual(Buffer.from([0x30, 0x03]));
    expect(resizeFrame(100, 30).toString()).toBe('1{"columns":100,"rows":30}');
    expect(PAUSE_FRAME.toString()).toBe("2");
    expect(RESUME_FRAME.toString()).toBe("3");
  });

  it("reads ttyd's frames", () => {
    expect(parseServerFrame(Buffer.from("0\x1b[31mhi"))).toEqual({ kind: "output", data: Buffer.from("\x1b[31mhi") });
    expect(parseServerFrame(Buffer.from("1herdr (box)"))).toEqual({ kind: "title", title: "herdr (box)" });
    expect(parseServerFrame(Buffer.from('2{"fontSize":13}'))).toEqual({ kind: "preferences", preferences: { fontSize: 13 } });
    expect(parseServerFrame(Buffer.from("2not json"))).toEqual({ kind: "preferences", preferences: null });
    expect(parseServerFrame(Buffer.from("9"))).toEqual({ kind: "unknown", command: 0x39 });
  });
});

interface StubTtyd {
  origin: string;
  frames: Buffer[];
  upgrades: http.IncomingHttpHeaders[];
  sockets: WebSocket[];
  /** Resolves with the socket once the client's handshake frame arrives. */
  opened: Promise<WebSocket>;
  close(): Promise<void>;
}

/**
 * A ttyd stand-in: `/terminal/ws` with the `tty` subprotocol, ttyd's
 * --check-origin rule (Origin's host[:port] must equal Host), and a bearer
 * check standing in for the gate.
 */
async function stubTtyd(opts: { status?: number; onFrame?: (ws: WebSocket, frame: Buffer) => void; silent?: boolean } = {}): Promise<StubTtyd> {
  const server = http.createServer();
  // `silent`: a box that has stopped answering (no pongs).
  const wss = new WebSocketServer({ noServer: true, autoPong: !opts.silent, handleProtocols: (p) => (p.has("tty") ? "tty" : false) });
  const frames: Buffer[] = [];
  const upgrades: http.IncomingHttpHeaders[] = [];
  const sockets: WebSocket[] = [];
  let resolveOpen: (ws: WebSocket) => void = () => {};
  const opened = new Promise<WebSocket>((r) => (resolveOpen = r));
  server.on("upgrade", (req, socket, head) => {
    upgrades.push(req.headers);
    const refuse = (status: number): void => {
      socket.end(`HTTP/1.1 ${status} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (opts.status) return refuse(opts.status);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return refuse(401);
    if (req.url !== "/terminal/ws") return refuse(404);
    const origin = new URL(String(req.headers.origin ?? "null"), "http://x");
    const want = origin.port ? `${origin.hostname}:${origin.port}` : origin.hostname;
    if (want !== req.headers.host) return refuse(403);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      let first = true;
      ws.on("message", (data: Buffer) => {
        frames.push(data);
        if (first) {
          first = false;
          ws.send(Buffer.from("1bash (box)"));
          ws.send(Buffer.from('2{"fontSize":13}'));
          ws.send(Buffer.from("0welcome\r\n"));
          resolveOpen(ws);
          return;
        }
        opts.onFrame?.(ws, data);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    frames,
    upgrades,
    sockets,
    opened,
    close: () =>
      new Promise((r) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const stubs: StubTtyd[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()?.close();
});

async function ttyd(opts: Parameters<typeof stubTtyd>[0] = {}): Promise<StubTtyd> {
  const s = await stubTtyd(opts);
  stubs.push(s);
  return s;
}

describe("a ttyd session", () => {
  it("opens with the tty subprotocol, the box's origin and the token, then sends its size", async () => {
    const s = await ttyd();
    const session = new TtydSession(new BoxClient(s.origin, TOKEN), "/terminal");
    const output: Buffer[] = [];
    const titles: string[] = [];
    session.on("output", (d) => output.push(d));
    session.on("title", (t) => titles.push(t));
    session.connect(132, 43);
    const ws = await s.opened;
    expect(s.upgrades[0]).toMatchObject({ origin: s.origin, authorization: `Bearer ${TOKEN}`, "sec-websocket-protocol": "tty" });
    expect(JSON.parse(s.frames[0]!.toString())).toEqual({ AuthToken: "", columns: 132, rows: 43 });
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(output).toString()).toBe("welcome\r\n");
    expect(titles).toEqual(["bash (box)"]);

    session.input(Buffer.from("echo hi\r"));
    session.resize(100, 30);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.frames.slice(1).map((f) => f.toString())).toEqual(["0echo hi\r", '1{"columns":100,"rows":30}']);

    const ended = new Promise<Ended>((r) => session.on("close", r));
    ws.close(1000);
    expect(await ended).toEqual({ reason: "exited", code: 1000, clean: true });
  });

  it("says why the box refused it", async () => {
    for (const [status, pattern] of [
      [401, /agentbox login/],
      [403, /origin/],
      [404, /no \/terminal terminal/],
      [502, /not running/],
    ] as const) {
      const s = await ttyd({ status });
      const session = new TtydSession(new BoxClient(s.origin, TOKEN), "/terminal");
      const ended = new Promise<Ended>((r) => session.on("close", r));
      session.connect(80, 24);
      const e = await ended;
      expect(e.reason).toBe("error");
      expect(e.reason === "error" && e.message, String(status)).toMatch(pattern);
    }
  });
});

describe("the detach keys", () => {
  it("detach on Ctrl-] then q, across chunks", () => {
    const f = new DetachFilter();
    expect(f.push(Buffer.from("ab\x1d"))).toEqual({ forward: Buffer.from("ab"), detach: false });
    expect(f.push(Buffer.from("q"))).toEqual({ forward: Buffer.from(""), detach: true });
    expect(new DetachFilter().push(Buffer.from("x\x1dQ"))).toEqual({ forward: Buffer.from("x"), detach: true });
  });

  it("pass Ctrl-] through when doubled, or followed by anything else", () => {
    const f = new DetachFilter();
    expect(f.push(Buffer.from("\x1d\x1d"))).toEqual({ forward: Buffer.from([0x1d]), detach: false });
    expect(f.push(Buffer.from("\x1dx"))).toEqual({ forward: Buffer.from("\x1dx"), detach: false });
    const plain = Buffer.from("no escape here");
    expect(f.push(plain).forward).toBe(plain);
  });
});

describe("the detach keys under kitty's keyboard protocol and modifyOtherKeys", () => {
  /** Feed the chunks in order; what went through, and whether it detached. */
  const feed = (...chunks: string[]): { forward: string; detach: boolean } => {
    const f = new DetachFilter();
    let forward = "";
    for (const c of chunks) {
      const r = f.push(Buffer.from(c, "latin1"));
      forward += r.forward.toString("latin1");
      if (r.detach) return { forward, detach: true };
    }
    return { forward, detach: false };
  };

  it("reads each spelling of Ctrl-] and q", () => {
    for (const [params, final] of [
      ["93;5", "u"],
      ["93;5:1", "u"],
      ["93;5:2", "u"],
      ["93:125;5", "u"],
      ["93;69", "u"],
      ["93;5;29", "u"],
      ["27;5;93", "~"],
    ]) {
      expect(classifyCsi(params as string, final as string), `${params}${final}`).toBe("prefix");
    }
    for (const [params, final] of [
      ["113", "u"],
      ["113;1", "u"],
      ["113;1:1", "u"],
      ["113:81;2", "u"],
      ["113;;113", "u"],
      ["27;1;113", "~"],
    ]) {
      expect(classifyCsi(params as string, final as string), `${params}${final}`).toBe("q");
    }
    expect(classifyCsi("93;5:3", "u")).toBe("release");
    expect(classifyCsi("113;1:3", "u")).toBe("release");
    expect(classifyCsi("57442;5", "u")).toBe("modifier");
    // Ctrl-Shift-], Alt-], Ctrl-q, and keys that are not keys at all.
    for (const [params, final] of [["93;6", "u"], ["93;3", "u"], ["113;5", "u"], ["2", "~"], ["1;5", "A"]]) {
      expect(classifyCsi(params as string, final as string), `${params}${final}`).toBe("other");
    }
  });

  it("detaches on kitty's Ctrl-] press, its release, then q (as the reviewer's repro sends them)", () => {
    expect(feed("\x1b[93;5u", "\x1b[93;5:3u", "q")).toEqual({ forward: "", detach: true });
    expect(feed("\x1b[93;5:1u\x1b[93;5:3u\x1b[113;1:1u")).toEqual({ forward: "", detach: true });
    expect(feed("\x1b[27;5;93~", "q")).toEqual({ forward: "", detach: true });
    // The Ctrl key's own events, with every key reported, change nothing.
    expect(feed("\x1b[57442;5u\x1b[93;5u", "\x1b[57442;1:3u", "\x1b[113u")).toEqual({ forward: "\x1b[57442;5u", detach: true });
  });

  it("waits for the rest of a sequence cut by the end of a read, but never holds Alt-[", () => {
    expect(feed("x\x1b[93;", "5u", "q")).toEqual({ forward: "x", detach: true });
    expect(feed("\x1b[9", "3;5u\x1b[113", "u")).toEqual({ forward: "", detach: true });
    expect(feed("\x1b[")).toEqual({ forward: "\x1b[", detach: false });
  });

  it("sends what it held, as typed, when anything else follows", () => {
    expect(feed("\x1b[93;5u", "\x1b[93;5:3u", "x")).toEqual({ forward: "\x1b[93;5u\x1b[93;5:3ux", detach: false });
    expect(feed("\x1b[93;5u", "\x1b[65;5u")).toEqual({ forward: "\x1b[93;5u\x1b[65;5u", detach: false });
    // Doubled: one Ctrl-] goes through.
    expect(feed("\x1b[93;5u", "\x1b[93;5u")).toEqual({ forward: "\x1b[93;5u", detach: false });
    // Arrow keys and the like pass untouched.
    expect(feed("\x1b[A\x1b[1;5C\x1b[200~paste\x1b[201~")).toEqual({ forward: "\x1b[A\x1b[1;5C\x1b[200~paste\x1b[201~", detach: false });
  });
});

describe("restoring the terminal", () => {
  it("undoes exactly the modes the program switched on", () => {
    const m = new ModeTracker();
    expect(m.restoreSequence()).toBe("\x1b[0m");
    m.observe(Buffer.from("\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h\x1b[?25l\x1b=\x1b[>1u"));
    const seq = m.restoreSequence();
    for (const part of ["\x1b[?1049l", "\x1b[?1000l", "\x1b[?1006l", "\x1b[?2004l", "\x1b[?25h", "\x1b>", "\x1b[<1u", "\x1b[0m"]) {
      expect(seq, JSON.stringify(part)).toContain(part);
    }
    expect(seq).not.toContain("\x1b[?1047l");
    // Switched back off by the program: nothing left to undo.
    m.observe(Buffer.from("\x1b[?1049l\x1b[?1000;1006l\x1b[?2004l\x1b[?25h\x1b>\x1b[<u"));
    expect(m.restoreSequence()).toBe("\x1b[0m");
  });

  it("undoes what herdr's TUI switches on, as recorded through ttyd", () => {
    const m = new ModeTracker();
    m.observe(
      Buffer.from(
        "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[?7l\x1b[?2026h\x1b[?25l\x1b[?2026l",
      ),
    );
    expect(m.restoreSequence()).toBe(
      "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?2031l\x1b[?25h\x1b[?7h\x1b[0m",
    );
  });

  it("undoes kitty's keyboard protocol, pushed or set in place", () => {
    const pushed = new ModeTracker();
    pushed.observe(Buffer.from("\x1b[>7u\x1b[?1049h"));
    expect(pushed.restoreSequence()).toBe("\x1b[?1049l\x1b[<1u\x1b[0m");
    const set = new ModeTracker();
    set.observe(Buffer.from("\x1b[=5;1u"));
    expect(set.restoreSequence()).toBe("\x1b[=0;1u\x1b[0m");
    set.observe(Buffer.from("\x1b[=0;1u"));
    expect(set.restoreSequence()).toBe("\x1b[0m");
  });

  it("sees a sequence cut in two by the chunk boundary", () => {
    const m = new ModeTracker();
    m.observe(Buffer.from("text\x1b[?10"));
    m.observe(Buffer.from("49h more"));
    expect(m.restoreSequence()).toContain("\x1b[?1049l");
    const n = new ModeTracker();
    n.observe(Buffer.from("\x1b"));
    n.observe(Buffer.from("[?1002h"));
    expect(n.restoreSequence()).toContain("\x1b[?1002l");
  });

  it("restores raw mode exactly once", () => {
    const stdin = fakeStdin(true);
    const stdout = capture({ isTTY: true });
    const guard = new TerminalGuard(stdin, stdout);
    guard.enter();
    guard.observe(Buffer.from("\x1b[?1049h"));
    guard.restore();
    guard.restore();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdout.text()).toBe("\x1b[?1049l\x1b[0m");
  });

  it("restores on a signal, on exit and on a crash", () => {
    for (const event of ["SIGTERM", "SIGHUP", "SIGINT", "exit", "uncaughtException"]) {
      const proc = new EventEmitter();
      const stdin = fakeStdin(true);
      const guard = new TerminalGuard(stdin, capture({ isTTY: true }));
      const signals: Array<[string, number]> = [];
      const crashes: unknown[] = [];
      guard.enter();
      const unhook = guardProcess(guard, proc, (s, c) => signals.push([s, c]), (e) => crashes.push(e));
      proc.emit(event, new Error("boom"));
      expect(stdin.rawModes, event).toEqual([true, false]);
      if (event.startsWith("SIG")) expect(signals).toEqual([[event, event === "SIGTERM" ? 143 : event === "SIGHUP" ? 129 : 130]]);
      if (event === "uncaughtException") expect(crashes).toHaveLength(1);
      unhook();
      expect(proc.listenerCount(event), event).toBe(0);
    }
  });
});

interface Wired {
  stdin: ReturnType<typeof fakeStdin>;
  stdout: Captured;
  stderr: Captured;
  proc: EventEmitter;
  done: Promise<number>;
  s: StubTtyd;
}

async function wire(opts: { tty?: boolean; onFrame?: (ws: WebSocket, frame: Buffer) => void; initialInput?: string; stdoutFull?: boolean } = {}): Promise<Wired> {
  const s = await ttyd(opts.onFrame ? { onFrame: opts.onFrame } : {});
  const stdin = fakeStdin(opts.tty ?? true);
  const stdout = capture({ isTTY: opts.tty ?? true, columns: 90, rows: 30 });
  if (opts.stdoutFull) stdout.write = (chunk: string | Uint8Array) => (stdout.chunks.push(Buffer.from(chunk)), false);
  const stderr = capture();
  const proc = new EventEmitter();
  const done = runTerminal({
    session: new TtydSession(new BoxClient(s.origin, TOKEN), "/terminal"),
    stdin,
    stdout,
    stderr,
    proc,
    env: { COLUMNS: "70", LINES: "20" },
    ...(opts.initialInput ? { initialInput: opts.initialInput } : {}),
    onCrash: () => {},
  });
  await s.opened;
  return { stdin, stdout, stderr, proc, done, s };
}

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("attach and shell, end to end against a stand-in ttyd", () => {
  it("runs raw, forwards keys, detaches on Ctrl-] q and puts the terminal back", async () => {
    const w = await wire({ onFrame: (ws, f) => ws.send(Buffer.concat([Buffer.from("0"), Buffer.from("\x1b[?1049h\x1b[?1000h"), f.subarray(1)])) });
    expect(JSON.parse(w.s.frames[0]!.toString())).toMatchObject({ columns: 90, rows: 30 });
    expect(w.stdin.rawModes).toEqual([true]);
    w.stdin.feed("ls\r");
    await tick();
    expect(w.s.frames[1]?.toString()).toBe("0ls\r");
    expect(w.stdout.text()).toContain("ls\r");
    w.stdin.feed("\x1d");
    w.stdin.feed("q");
    expect(await w.done).toBe(0);
    expect(w.stdin.rawModes).toEqual([true, false]);
    expect(w.stdout.text().endsWith("\x1b[?1049l\x1b[?1000l\x1b[0m")).toBe(true);
    expect(w.stderr.text()).toContain("[detached]");
    // The keys that detached never reached the box.
    expect(w.s.frames.map((f) => f.toString()).join("")).not.toContain("\x1d");
  });

  it("follows the window size", async () => {
    const w = await wire();
    w.stdout.columns = 150;
    w.stdout.rows = 50;
    emit(w.stdout, "resize");
    await tick();
    expect(w.s.frames[1]?.toString()).toBe('1{"columns":150,"rows":50}');
    w.s.sockets[0]?.close(1000);
    expect(await w.done).toBe(0);
  });

  it("exits with the remote program: 0 when it exited cleanly, 1 otherwise", async () => {
    const clean = await wire();
    clean.s.sockets[0]?.close(1000);
    expect(await clean.done).toBe(0);
    expect(clean.stdin.rawModes).toEqual([true, false]);

    const failed = await wire();
    failed.s.sockets[0]?.close(4000);
    expect(await failed.done).toBe(1);
    expect(failed.stdin.rawModes).toEqual([true, false]);
    expect(failed.stderr.text()).toMatch(/the session ended/);
  });

  it("restores the terminal and exits 128+n on a signal", async () => {
    const w = await wire();
    w.proc.emit("SIGTERM");
    expect(await w.done).toBe(143);
    expect(w.stdin.rawModes).toEqual([true, false]);
  });

  it("notices a box that stopped answering, and restores the terminal", async () => {
    const s = await ttyd({ silent: true });
    const stdin = fakeStdin(true);
    const stderr = capture();
    const session = new TtydSession(new BoxClient(s.origin, TOKEN), "/terminal");
    const origConnect = session.connect.bind(session);
    session.connect = (c: number, r: number) => origConnect(c, r, { pingMs: 30 });
    const done = runTerminal({ session, stdin, stdout: capture({ isTTY: true }), stderr, proc: new EventEmitter(), onCrash: () => {} });
    await s.opened;
    expect(await done).toBe(1);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stderr.text()).toMatch(/stopped answering/);
  });

  it("restores the terminal when the connection drops", async () => {
    const w = await wire();
    w.s.sockets[0]?.terminate();
    expect(await w.done).toBe(1);
    expect(w.stdin.rawModes).toEqual([true, false]);
  });

  it("asks ttyd to pause while the terminal cannot keep up", async () => {
    const w = await wire({ stdoutFull: true, onFrame: (ws) => ws.send(Buffer.from("0lots of output")) });
    w.stdin.feed("x");
    await tick();
    expect(w.s.frames.map((f) => f.toString())).toContain("2");
    emit(w.stdout, "drain");
    await tick();
    expect(w.s.frames.map((f) => f.toString())).toContain("3");
    w.s.sockets[0]?.close(1000);
    await w.done;
  });

  it("works without a terminal: no raw mode, the size from the environment", async () => {
    const w = await wire({ tty: false });
    expect(JSON.parse(w.s.frames[0]!.toString())).toMatchObject({ columns: 90, rows: 30 });
    expect(w.stdin.rawModes).toEqual([]);
    w.stdin.feed("exit\r");
    await tick();
    expect(w.s.frames[1]?.toString()).toBe("0exit\r");
    w.s.sockets[0]?.close(1000);
    expect(await w.done).toBe(0);
  });

  it("types --cwd's cd first, quoted for bash", async () => {
    const w = await wire({ initialInput: cdCommand("/workspace/it's here") });
    await tick();
    expect(w.s.frames[1]?.toString()).toBe(`0 cd -- '/workspace/it'\\''s here' && clear\r`);
    w.s.sockets[0]?.close(1000);
    await w.done;
    expect(cdCommand("~/proj")).toBe(" cd -- ~/'proj' && clear\r");
    expect(cdCommand("~")).toBe(" cd -- ~ && clear\r");
  });
});
