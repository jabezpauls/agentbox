import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ConfigStore } from "../src/config.js";
import type { InStream, Io, OutStream } from "../src/context.js";
import { run } from "../src/main.js";

/** A writable that remembers what was written. */
export interface Captured extends OutStream {
  text(): string;
  chunks: Buffer[];
}

export function capture(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}): Captured {
  const chunks: Buffer[] = [];
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const s: Captured = {
    chunks,
    isTTY: opts.isTTY ?? false,
    ...(opts.columns ? { columns: opts.columns } : {}),
    ...(opts.rows ? { rows: opts.rows } : {}),
    write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
      chunks.push(Buffer.from(chunk));
      cb?.();
      return true;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    on(event: string, fn: (...a: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return s;
    },
    off(event: string, fn: (...a: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== fn),
      );
      return s;
    },
    once(event: string, fn: (...a: unknown[]) => void) {
      const wrapped = (...a: unknown[]): void => {
        s.off?.(event, wrapped);
        fn(...a);
      };
      return s.on?.(event, wrapped);
    },
  };
  (s as Captured & { emit(ev: string, ...a: unknown[]): void }).emit = (ev: string, ...a: unknown[]) => {
    for (const fn of listeners.get(ev) ?? []) fn(...a);
  };
  return s;
}

export function emit(s: OutStream, ev: string, ...args: unknown[]): void {
  (s as unknown as { emit(ev: string, ...a: unknown[]): void }).emit(ev, ...args);
}

/** A stdin that can pretend to be a terminal, and says when raw mode changes. */
export interface FakeStdin extends InStream {
  rawModes: boolean[];
  isRaw: boolean;
  feed(data: string | Buffer): void;
}

export function fakeStdin(isTTY = true): FakeStdin {
  const s = new PassThrough() as unknown as FakeStdin & PassThrough;
  s.isTTY = isTTY;
  s.rawModes = [];
  s.isRaw = false;
  if (isTTY) {
    s.setRawMode = (mode: boolean) => {
      s.rawModes.push(mode);
      s.isRaw = mode;
      return s;
    };
  }
  s.feed = (data) => s.write(data);
  return s;
}

const made: string[] = [];

/** A fresh temporary folder, removed when the test file is done (see setup.ts). */
export function tmpDir(prefix = "agentbox-cli-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function removeTmpDirs(): void {
  for (const dir of made.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // gone already
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface Stub {
  url: string;
  port: number;
  seen: Seen[];
  server: http.Server;
  close(): Promise<void>;
}

/** A stand-in for a box: `handler` answers every request, with its body read into `seen`. */
export async function stubServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void>,
): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    server,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

export const TOKEN = `abx_${"A".repeat(43)}`;
export const TOKEN2 = `abx_${"B".repeat(43)}`;

/** A configuration directory already signed in to `url` as box "test". */
export function signedIn(url: string, token = TOKEN, extra: Record<string, unknown> = {}): string {
  const dir = tmpDir();
  const store = new ConfigStore(dir);
  store.update((d) => {
    d.boxes.test = { url, token, addedAt: 1, versionCheckedAt: Date.now(), ...extra };
    d.current = "test";
  });
  return dir;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process with captured streams. */
export async function runCli(
  argv: string[],
  opts: { configDir: string; env?: NodeJS.ProcessEnv; stdin?: InStream; stdout?: Captured; platform?: NodeJS.Platform; signal?: AbortSignal },
): Promise<CliRun> {
  const stdout = opts.stdout ?? capture();
  const stderr = capture();
  const io: Io = { stdout, stderr, stdin: opts.stdin ?? fakeStdin(false) };
  const code = await run(argv, {
    io,
    configDir: opts.configDir,
    // Temporary files (files edit) go where the tests clean up.
    env: { PATH: process.env.PATH, TMPDIR: tmpDir(), HOME: tmpDir(), ...(opts.env ?? {}) },
    platform: opts.platform ?? "linux",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
