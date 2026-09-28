import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoxClient } from "./http.js";

/**
 * The local WebDAV front that `agentbox mount` puts the OS's WebDAV client in
 * front of. The OS clients (Finder, GNOME's gvfs, Windows' WebClient) speak
 * WebDAV but cannot carry a device token, so this carries it for them:
 *
 *   client ── http://127.0.0.1:<port>/<secret>/… ──▶ front ── https://box/api/dav/… + Bearer ──▶ box
 *
 * Anyone who can reach it would reach the box as this device, so it is
 * guarded three ways, each enough on its own against a web page, and
 * together against another user of this machine:
 *
 * - it listens on loopback only, and refuses a `Host` that is not loopback,
 *   so a DNS-rebinding page cannot reach it by name;
 * - it answers nothing outside `/<secret>/`, a random 128-bit path;
 * - it asks for HTTP Basic credentials: a user name and a random 192-bit
 *   password made for this run, which `mount` hands the OS's client outside
 *   any command line (the secret path shows in `ps` and the mount table; the
 *   password does not). Windows' WebClient will not send Basic credentials
 *   over plain http, so there the path is the secret, and says so.
 *
 * WebDAV names resources by URL in more places than the request line, and
 * each has to be translated between the two namespaces or the box refuses
 * the request (a `Destination` on another host is a 502 by RFC 4918):
 *
 * - the request path: `/<secret>/x` ⇄ `/api/dav/x`;
 * - the `Destination` header (COPY, MOVE): made absolute on the box's own
 *   origin, which is the host the box sees;
 * - resource tags in the `If` header (locks);
 * - `href`s in multistatus bodies (PROPFIND, PROPPATCH, LOCK and partial
 *   failures), and `Location`/`Content-Location` in responses.
 */

export const REMOTE_PREFIX = "/api/dav";

export interface DavMap {
  /** `/<secret>`: the local root, without a trailing slash. */
  localPrefix: string;
  /** `http://127.0.0.1:<port>`. */
  localOrigin: string;
  /** The box's origin. */
  remoteOrigin: string;
  remotePrefix: string;
}

export class BadPath extends Error {}

/** Decode `%XX` escapes to bytes; a stray `%` stays a `%`. */
function percentDecode(s: string): Buffer {
  const out: number[] = [];
  const raw = Buffer.from(s, "utf8");
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] as number;
    if (b === 0x25 && i + 2 < raw.length) {
      const hex = String.fromCharCode(raw[i + 1] as number, raw[i + 2] as number);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(b);
  }
  return Buffer.from(out);
}

/**
 * One path segment, passed on exactly as the client spelled it — a filename
 * may hold `;`, `%`, even a backslash (as `%5C`), and the gate sends
 * everything under /api/dav to the bridge raw, whose WebDAV handler decodes
 * each segment itself — unless it could climb out of /api/dav on the way
 * there. Between here and the gate there may be a proxy that normalises URLs
 * (Cloudflare decodes `%2E`, turns `\` into `/`, and removes dot segments),
 * and this front adds the device token to whatever it forwards, so a segment
 * that is, or decodes to, `.` or `..`, or that holds a slash, a raw backslash
 * or NUL, is refused here.
 */
export function checkedSegment(seg: string): string {
  if (seg.includes("\\")) throw new BadPath("backslash in a path");
  const text = percentDecode(seg).toString("latin1");
  if (text === "." || text === "..") throw new BadPath("dot segment");
  if (text.includes("/") || text.includes("\0")) throw new BadPath("slash or NUL in a name");
  return seg;
}

/** `/a//b/` → `/a/b/`: every segment checked, empty ones dropped, a trailing slash kept. */
export function checkedPath(rest: string): string {
  if (rest === "") return "";
  if (!rest.startsWith("/")) throw new BadPath("not a path");
  const trailing = rest.length > 1 && rest.endsWith("/");
  const segs = rest
    .split("/")
    .filter((s) => s !== "")
    .map(checkedSegment);
  return `/${segs.join("/")}${trailing && segs.length ? "/" : ""}`;
}

/** The box's path for a local request target (path and query), or `null` when it is not under the secret. */
export function toRemotePath(target: string, m: DavMap): string | null {
  const q = target.indexOf("?");
  const p = q === -1 ? target : target.slice(0, q);
  const qs = q === -1 ? "" : target.slice(q);
  if (!underPrefix(p, m.localPrefix)) return null;
  return `${m.remotePrefix}${checkedPath(p.slice(m.localPrefix.length))}${qs}`;
}

function underPrefix(p: string, prefix: string): boolean {
  if (p.length < prefix.length) return false;
  const head = Buffer.from(p.slice(0, prefix.length));
  const want = Buffer.from(prefix);
  // Compared in constant time: the prefix is the secret.
  if (head.length !== want.length || !timingSafeEqual(head, want)) return false;
  return p.length === prefix.length || p[prefix.length] === "/";
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** True when a `Host` header names this front on loopback (so not a rebinding page's host). */
export function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return LOOPBACK_HOSTS.some((l) => h === `${l}:${port}`);
}

/**
 * `Destination` for the box: absolute, on the box's origin, under its prefix.
 * `null` when it names somewhere other than this front — a copy to another
 * server, which the front answers itself (502, as RFC 4918 says).
 */
export function toRemoteDestination(value: string, m: DavMap, port: number): string | null {
  let url: URL;
  try {
    url = new URL(value.trim(), m.localOrigin);
  } catch {
    return null;
  }
  if (!isLocalHost(url.host, port) || url.protocol !== "http:") return null;
  let remote: string | null;
  try {
    remote = toRemotePath(url.pathname, m);
  } catch {
    return null;
  }
  return remote === null ? null : `${m.remoteOrigin}${remote}`;
}

/** The `If` header's resource tags (`<url>`) moved to the box; lock tokens left alone. */
export function toRemoteIf(value: string, m: DavMap, port: number): string {
  return value.replace(/<([^>]*)>/g, (whole, inner: string) => {
    if (!/^(https?:\/\/|\/)/i.test(inner.trim())) return whole;
    const dest = toRemoteDestination(inner, m, port);
    return dest ? `<${dest}>` : whole;
  });
}

/** A URL the box gave (an href, a Location) as the client must see it. */
export function toLocalHref(href: string, m: DavMap): string {
  const trimmed = href.trim();
  let p = trimmed;
  let absolute = false;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return href;
    }
    if (url.origin !== new URL(m.remoteOrigin).origin) return href;
    p = `${url.pathname}${url.search}`;
    absolute = true;
  }
  if (p !== m.remotePrefix && !p.startsWith(`${m.remotePrefix}/`) && !p.startsWith(`${m.remotePrefix}?`)) return href;
  const local = `${m.localPrefix}${p.slice(m.remotePrefix.length)}`;
  return absolute ? `${m.localOrigin}${local}` : local;
}

/**
 * Every `href` element in a multistatus (or error) body, moved to the local
 * namespace, whatever the DAV namespace's prefix is. The prefixes swapped
 * contain nothing XML escapes, so the element's text is edited as it stands.
 */
export function rewriteXmlHrefs(xml: string, m: DavMap): string {
  return xml.replace(
    /(<(?:[A-Za-z_][\w.-]*:)?href(?:\s[^>]*)?>)([^<]*)(<\/(?:[A-Za-z_][\w.-]*:)?href\s*>)/g,
    (_whole, open: string, inner: string, close: string) => `${open}${toLocalHref(inner, m)}${close}`,
  );
}

// RFC 7230 §6.1, plus what the front sets itself.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
/** Never passed to the box: the front's own address, and anything that could carry a credential of the client's. */
const DROP_REQUEST = new Set(["host", "authorization", "proxy-authorization", "cookie", "origin", "referer", "destination", "if", "accept-encoding"]);
const DROP_RESPONSE = new Set(["set-cookie", "www-authenticate", "strict-transport-security", "alt-svc"]);

/** Multistatus bodies are small; anything past this is passed through unedited rather than held. */
const MAX_REWRITE = 64 * 1024 * 1024;

/** The Basic credentials the front asks for. */
export interface DavCredentials {
  user: string;
  password: string;
}

export function newCredentials(): DavCredentials {
  return { user: "agentbox", password: randomBytes(24).toString("base64url") };
}

/** True when an `Authorization` header carries exactly these credentials (compared in constant time). */
export function basicMatches(header: string | undefined, want: DavCredentials): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!m) return false;
  const got = Buffer.from(m[1] as string, "base64");
  const expected = Buffer.from(`${want.user}:${want.password}`, "utf8");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface DavFrontOptions {
  host?: string;
  port?: number;
  secret?: string;
  /** The credentials to ask for (default: new ones); `null` asks for none (Windows' WebClient, see above). */
  credentials?: DavCredentials | null;
  /** Told about requests the box refused as unauthorised, once. */
  onUnauthorized?: () => void;
  onError?: (message: string) => void;
}

export class DavFront {
  private server: http.Server | null = null;
  private map: DavMap | null = null;
  private port = 0;
  private warnedAuth = false;
  readonly secret: string;
  /** What a client must sign in with, or `null` when nothing is asked. */
  readonly credentials: DavCredentials | null;

  constructor(
    private readonly client: BoxClient,
    private readonly opts: DavFrontOptions = {},
  ) {
    this.secret = opts.secret ?? randomBytes(16).toString("base64url");
    this.credentials = opts.credentials === undefined ? newCredentials() : opts.credentials;
  }

  /** Start listening; resolves with the URL to give a WebDAV client. */
  async start(): Promise<string> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.opts.onError?.((err as Error).message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("the box could not be reached\n");
        } else {
          res.destroy();
        }
      });
    });
    server.keepAliveTimeout = 65_000;
    // Node's default gives a whole request five minutes, body included, then
    // answers 408: a large file copied into the mount over a slow link would
    // fail part way. A request may take as long as it needs; the connection
    // to the box has its own idle limit, and headers must still come quickly.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    const localOrigin = `http://127.0.0.1:${this.port}`;
    this.map = { localPrefix: `/${this.secret}`, localOrigin, remoteOrigin: this.client.origin, remotePrefix: REMOTE_PREFIX };
    return `${localOrigin}/${this.secret}/`;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/${this.secret}/`;
  }

  get listenPort(): number {
    return this.port;
  }

  /** The listening server's own deadlines (for the tests). */
  get timeouts(): { request: number; headers: number } | null {
    return this.server ? { request: this.server.requestTimeout, headers: this.server.headersTimeout } : null;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = this.map as DavMap;
    const plain = (status: number, text: string): void => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(text) + 1) });
      res.end(`${text}\n`);
    };
    if (!isLocalHost(req.headers.host, this.port)) return plain(403, "forbidden");
    let target: string | null;
    try {
      target = toRemotePath(req.url ?? "", m);
    } catch {
      return plain(400, "bad path");
    }
    // Outside the secret: the same answer as a path that does not exist.
    if (target === null) return plain(404, "not found");
    const credentials = this.credentials;
    if (credentials && !basicMatches(req.headers.authorization, credentials)) {
      const text = "sign in with the user name and password agentbox mount printed or passed on\n";
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(text)), "www-authenticate": 'Basic realm="agentbox", charset="UTF-8"' });
      res.end(text);
      return;
    }
    const method = req.method ?? "GET";

    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || DROP_REQUEST.has(name)) continue;
      headers[name] = value;
    }
    const destination = req.headers.destination;
    if (typeof destination === "string") {
      const moved = toRemoteDestination(destination, m, this.port);
      if (!moved) return plain(502, "the destination is not on this server");
      headers.destination = moved;
    }
    if (typeof req.headers.if === "string") headers.if = toRemoteIf(req.headers.if, m, this.port);
    const rewrites = method !== "GET" && method !== "HEAD";
    // Bodies to rewrite must arrive readable; file contents may be compressed on the way.
    headers["accept-encoding"] = rewrites ? "identity" : (req.headers["accept-encoding"] ?? "identity");
    const hasBody = req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;

    let upstream;
    try {
      upstream = await this.client.request(method, target, { headers, ...(hasBody ? { body: req } : {}), idleMs: 300_000 });
    } catch (err) {
      this.opts.onError?.((err as Error).message);
      return plain(502, "the box could not be reached");
    }
    if (upstream.status === 401 && !this.warnedAuth) {
      this.warnedAuth = true;
      this.opts.onUnauthorized?.();
    }

    const out: Array<[string, string | string[]]> = [];
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || DROP_RESPONSE.has(name)) continue;
      if (name === "location" || name === "content-location") out.push([name, toLocalHref(String(value), m)]);
      else out.push([name, value]);
    }
    const type = String(upstream.headers["content-type"] ?? "");
    const encoded = upstream.headers["content-encoding"] !== undefined && upstream.headers["content-encoding"] !== "identity";
    const length = Number(upstream.headers["content-length"] ?? NaN);
    if (rewrites && /\bxml\b/i.test(type) && !encoded && !(length > MAX_REWRITE)) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of upstream.stream) {
        size += (c as Buffer).length;
        chunks.push(c as Buffer);
      }
      const body = Buffer.from(rewriteXmlHrefs(Buffer.concat(chunks, size).toString("utf8"), m), "utf8");
      const headersOut = out.filter(([n]) => n !== "content-length");
      headersOut.push(["content-length", String(body.length)]);
      res.writeHead(upstream.status, Object.fromEntries(headersOut));
      res.end(body);
      return;
    }
    res.writeHead(upstream.status, Object.fromEntries(out));
    upstream.stream.pipe(res);
    upstream.stream.on("error", () => res.destroy());
    // The client went away mid-download: stop pulling from the box.
    res.on("close", () => {
      if (!res.writableFinished) upstream.stream.destroy();
    });
  }
}
