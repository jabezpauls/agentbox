import { Duplex } from "node:stream";
import net from "node:net";
import { WebSocket } from "ws";
import { CliError, EXIT, UsageError } from "./errors.js";
import type { BoxClient } from "./http.js";
import { PING_MS, keepAlive } from "./keepalive.js";

/**
 * Tunnels: a byte stream to something inside the box, over one WebSocket.
 *
 * The gate's endpoint (Phase C) is `GET /_gate/tunnel?target=tcp:<port>` or
 * `?target=herdr`, a WebSocket that takes a device token only. Binary frames
 * carry raw bytes both ways; a text frame is control — `{"type": "error",
 * "message"}` — and the socket closes after it. Pings every 25 s keep
 * Cloudflare, which drops a socket idle for 100 s, from cutting a quiet one.
 *
 * `forward` is built on this; `herdr call|socket` (herdr's newline-delimited
 * JSON over a Unix socket, target `herdr`) and the `apps` commands plug in
 * the same way.
 */

export type TunnelTarget = { kind: "tcp"; port: number } | { kind: "herdr" };

export function targetParam(t: TunnelTarget): string {
  return t.kind === "tcp" ? `tcp:${t.port}` : "herdr";
}

export const TUNNEL_PATH = "/_gate/tunnel";

/** A control frame from the far end. */
export interface ControlFrame {
  type: string;
  message?: string;
}

export class TunnelError extends CliError {}

/** The tunnel as a Node stream: write bytes in, read bytes out. */
export class TunnelStream extends Duplex {
  private readonly stopKeepAlive: () => void;

  constructor(
    private readonly ws: WebSocket,
    pingMs = PING_MS,
  ) {
    super();
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        let control: ControlFrame | null = null;
        try {
          control = JSON.parse(data.toString("utf8")) as ControlFrame;
        } catch {
          // Not ours to read.
        }
        // Destroyed on the next turn, not this one: the box sends the error
        // the moment the far end refuses, which can be in the same breath as
        // the socket opening — before whoever awaited openTunnel has had the
        // chance to listen for it, which would make it an uncaught error.
        if (control?.type === "error") {
          const err = new TunnelError(control.message ?? "the tunnel failed");
          setImmediate(() => this.destroy(err));
        }
        return;
      }
      if (!this.push(data)) ws.pause();
    });
    ws.on("close", () => {
      this.stopKeepAlive();
      this.push(null);
    });
    ws.on("error", (err) => this.destroy(err));
    this.stopKeepAlive = keepAlive(ws, () => this.destroy(new TunnelError("the box stopped answering; the tunnel is closed")), pingMs);
  }

  override _read(): void {
    this.ws.resume();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) return cb(new TunnelError("the tunnel is closed"));
    this.ws.send(chunk, { binary: true }, (err) => cb(err ?? null));
  }

  override _final(cb: (err?: Error | null) => void): void {
    // WebSocket has no half-close: the local end is done, so is the tunnel.
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.stopKeepAlive();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    cb(err);
  }
}

/** Open a tunnel; rejects with what the box said when it refuses. */
export function openTunnel(client: BoxClient, target: TunnelTarget, opts: { pingMs?: number } = {}): Promise<TunnelStream> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(client.wsUrl(`${TUNNEL_PATH}?target=${encodeURIComponent(targetParam(target))}`), {
      headers: client.baseHeaders(),
      perMessageDeflate: false,
      handshakeTimeout: 30_000,
    });
    ws.binaryType = "nodebuffer";
    let settled = false;
    const early = (data: Buffer, isBinary: boolean): void => {
      // An error frame before anything else: the box could not reach the target.
      if (isBinary) return;
      try {
        const control = JSON.parse(data.toString("utf8")) as ControlFrame;
        if (control.type === "error") fail(new TunnelError(control.message ?? "the tunnel failed"));
      } catch {
        // ignore
      }
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(err);
    };
    ws.once("open", () => {
      if (settled) return;
      settled = true;
      ws.off("message", early);
      resolve(new TunnelStream(ws, opts.pingMs));
    });
    ws.on("message", early);
    ws.once("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      fail(
        status === 401
          ? new CliError("the box did not accept this device's sign-in; run `agentbox login` again", EXIT.AUTH)
          : status === 404
            ? new CliError(`${client.origin} has no tunnel endpoint yet; update the box`, EXIT.NOT_FOUND)
            : new TunnelError(`the box refused the tunnel (HTTP ${status})`),
      );
    });
    ws.once("error", (err) => fail(new CliError(`could not open a tunnel to ${client.origin}: ${err.message}`, EXIT.UNREACHABLE)));
  });
}

export interface ForwardSpec {
  remote: number;
  local: number;
}

/** `5173` (the same port here) or `5173:3000` (remote 5173 at local 3000). */
export function parseForwardSpec(raw: string): ForwardSpec {
  const m = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(raw);
  const remote = Number(m?.[1]);
  const local = m?.[2] !== undefined ? Number(m[2]) : remote;
  if (!m || remote < 1 || remote > 65535 || local < 1 || local > 65535) {
    throw new UsageError(`"${raw}" is not a port to forward: give <port> or <remote port>:<local port>`);
  }
  return { remote, local };
}

/**
 * Listen on `127.0.0.1:<local>`; every connection gets its own tunnel to
 * `tcp:<remote>` in the box.
 */
export async function forwardPort(
  client: BoxClient,
  spec: ForwardSpec,
  opts: { host?: string; onError?: (err: Error) => void; pingMs?: number } = {},
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.pause();
    openTunnel(client, { kind: "tcp", port: spec.remote }, opts.pingMs ? { pingMs: opts.pingMs } : {})
      .then((tunnel) => {
        socket.pipe(tunnel).pipe(socket);
        socket.resume();
        const drop = (): void => {
          socket.destroy();
          tunnel.destroy();
        };
        socket.on("error", drop);
        socket.on("close", () => tunnel.destroy());
        tunnel.on("error", (err: Error) => {
          opts.onError?.(err);
          drop();
        });
        tunnel.on("close", () => socket.end());
      })
      .catch((err: Error) => {
        opts.onError?.(err);
        socket.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(new CliError(err.code === "EADDRINUSE" ? `port ${spec.local} is already in use here; forward to another, e.g. ${spec.remote}:${spec.local + 1}` : err.message)),
    );
    server.listen(spec.local, opts.host ?? "127.0.0.1", () => resolve());
  });
  return server;
}
