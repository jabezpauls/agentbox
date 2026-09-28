import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { ApiError, CliError, EXIT } from "./errors.js";
import { safeText } from "./format.js";
import { VERSION } from "./version.js";

/**
 * Talking to a box: plain `node:http`/`node:https`, so a body can stream both
 * ways with a known length (a 50 MiB upload chunk is never held in memory),
 * any WebDAV method passes, and nothing is added to a request behind the
 * caller's back. Every request carries the device token as a bearer token —
 * the gate exempts bearer requests from its same-origin checks, since a page
 * on another site cannot attach one — and a User-Agent saying who is asking.
 */

export type Body = string | Buffer | Readable | { json: unknown };

export interface RequestOptions {
  /** Query parameters; arrays repeat the key. Values are sent percent-encoded. */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  /** A query string already encoded, appended after `query` (for byte-exact paths). */
  rawQuery?: string;
  headers?: OutgoingHttpHeaders;
  body?: Body;
  /** Send the token (the default). The gate's unauthenticated calls go without. */
  auth?: boolean;
  /** Give up when the connection is idle this long. */
  idleMs?: number;
  signal?: AbortSignal;
}

export interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body, unread. Consume it, or call `discard()`. */
  stream: IncomingMessage;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  discard(): void;
}

export const USER_AGENT = `agentbox-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;

/** The default idle limit: a box that says nothing for this long is not answering. */
const IDLE_MS = 60_000;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** What went wrong at the network level, said plainly. */
export function describeNetworkError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { cause?: unknown };
  switch (e.code) {
    case "ECONNREFUSED":
      return "the connection was refused";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "the name does not resolve";
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return "it timed out";
    case "ECONNRESET":
      return "the connection was reset";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "the network is unreachable";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `its TLS certificate is not valid (${e.code})`;
    default:
      return e.message || String(err);
  }
}

/** Build `?a=1&b=x&b=y` from `query`, keys in order, undefined values left out. */
export function encodeQuery(query: RequestOptions["query"], rawQuery?: string): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    const values = Array.isArray(v) ? v : [String(v)];
    for (const one of values) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(one)}`);
  }
  if (rawQuery) parts.push(rawQuery);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** The message a refusal carries: the API's `message`, else its `error`, else the status. */
export function apiErrorFrom(status: number, text: string, what: string): ApiError {
  let message = "";
  let code: string | null = null;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown };
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string") code = body.code;
    else if (typeof body.error === "string") code = body.error;
  } catch {
    message = text.trim().split("\n")[0] ?? "";
  }
  // The box's words, shown as they are and never acted on by the terminal.
  message = safeText(message.slice(0, 300));
  if (status === 401) {
    return new ApiError(401, "the box did not accept this device's sign-in (the token was revoked or has expired); run `agentbox login` again", code);
  }
  if (status === 502 || status === 503 || status === 504) {
    message = message || "the box is up, but the service behind it is not answering";
  }
  return new ApiError(status, `${what}: ${message || `HTTP ${status}`}`, code);
}

export class BoxClient {
  readonly origin: string;
  private readonly url: URL;
  private readonly agent: http.Agent;

  constructor(
    origin: string,
    private readonly token: string | null,
  ) {
    this.url = new URL(origin);
    this.origin = this.url.origin;
    const Agent = this.url.protocol === "https:" ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 8 });
  }

  get host(): string {
    return this.url.host;
  }

  /** The WebSocket URL for a path on the box. */
  wsUrl(pathAndQuery: string): string {
    return `${this.url.protocol === "https:" ? "wss:" : "ws:"}//${this.url.host}${pathAndQuery}`;
  }

  /** Headers every request to the box carries; the token only when asked for. */
  baseHeaders(auth = true): Record<string, string> {
    const h: Record<string, string> = { "user-agent": USER_AGENT };
    if (auth && this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: OutgoingHttpHeaders = { ...this.baseHeaders(opts.auth !== false), ...(opts.headers ?? {}) };
    let payload: Buffer | Readable | null = null;
    const body = opts.body;
    if (body !== undefined) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
      } else if (body instanceof Readable) {
        payload = body;
      } else {
        payload = Buffer.from(JSON.stringify(body.json), "utf8");
        headers["content-type"] ??= "application/json";
      }
      if (Buffer.isBuffer(payload)) headers["content-length"] = String(payload.length);
    }
    const target = `${path}${encodeQuery(opts.query, opts.rawQuery)}`;
    const lib = this.url.protocol === "https:" ? https : http;

    return new Promise<Response>((resolve, reject) => {
      const req = lib.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname.replace(/^\[|\]$/g, ""),
          port: this.url.port || undefined,
          method,
          path: target,
          headers,
          agent: this.agent,
          signal: opts.signal,
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            stream: res,
            text: async () => (await readAll(res)).toString("utf8"),
            json: async <T>() => JSON.parse((await readAll(res)).toString("utf8")) as T,
            discard: () => {
              res.resume();
            },
          });
        },
      );
      req.setTimeout(opts.idleMs ?? IDLE_MS, () => {
        req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
      });
      req.on("error", (err) => {
        if ((err as Error).name === "AbortError") reject(new CliError("interrupted", EXIT.INTERRUPTED));
        else reject(new CliError(`could not reach ${this.origin}: ${describeNetworkError(err)}`, EXIT.UNREACHABLE));
      });
      if (payload instanceof Readable) {
        payload.on("error", (err) => req.destroy(err));
        payload.pipe(req);
      } else {
        req.end(payload ?? undefined);
      }
    });
  }

  /**
   * A JSON call: the parsed answer on 2xx, else an {@link ApiError} with what
   * the box said. `what` names the action for the message ("listing /x").
   */
  async json<T>(method: string, path: string, opts: RequestOptions & { what?: string } = {}): Promise<T> {
    const res = await this.request(method, path, { ...opts, headers: { accept: "application/json", ...(opts.headers ?? {}) } });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw apiErrorFrom(res.status, text, opts.what ?? `${method} ${path}`);
    if (res.status === 204 || text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`${opts.what ?? path}: the box answered with something that is not JSON (is ${this.origin} an agentbox?)`);
    }
  }

  /** A request whose answer must be 2xx; the body is left to the caller. */
  async ok(method: string, path: string, opts: RequestOptions & { what?: string } = {}): Promise<Response> {
    const res = await this.request(method, path, opts);
    if (res.status < 200 || res.status >= 300) throw apiErrorFrom(res.status, await res.text(), opts.what ?? `${method} ${path}`);
    return res;
  }

  close(): void {
    this.agent.destroy();
  }
}
