import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import {
  APP_SANDBOX,
  FONT_PATH,
  appOriginAllowed,
  appResponseHeaders,
  editableType,
  isFontType,
  isNullPreflight,
  preflightHeaders,
  type PolicyContext,
} from "./app-policy.js";
import type { AppChange, AppRegistry } from "./apps.js";
import type { Ended, Subject } from "./auth.js";
import type { Upstream } from "./config.js";
import type { GateCore, RequestInfo } from "./context.js";
import { HINT_HEADER, RESERVED, rewriteCss, rewriteHtml, shimSource } from "./fidelity.js";
import { grantCookie, grantValues, OWNER_GRANT_MS, PASSCODE_GRANT_MS, type Grants, type GrantSubject } from "./grants.js";
import { isStrictPath } from "./path-guard.js";
import { PASSCODE_CSP, renderPasscode, type PasscodeView } from "./pages.js";
import {
  SECURITY_HEADERS,
  badGateway,
  filterResponseHeaders,
  forwardRequestHeaders,
  refuseUpgrade,
  type Forwarded,
} from "./proxy.js";
import type { WindowLimiter } from "./ratelimit.js";
import type { AppRecord } from "./store.js";

/**
 * `/a/<id>/…`: who may open an app, and the app policy on everything that
 * passes.
 *
 * Who may open it, in order:
 *
 * 1. a valid app grant for this app (the cookie a page load or a passcode
 *    minted) — the only thing an app's own page can send, from its opaque
 *    origin;
 * 2. a session or a device token — and a page load (a navigation) mints a
 *    grant, so the page's own requests carry one;
 * 3. anyone, when the owner shared it with the link and it has not expired;
 * 4. anyone with the passcode, when shared with one: a page load without a
 *    grant is shown the passcode page, and the right passcode mints a grant;
 * 5. nobody else: a page load is sent to sign in, anything else is `404` —
 *    the answer an unknown id gets, so a private app and none look alike.
 *    Each such refusal costs from a per-address budget, so ids cannot be
 *    enumerated.
 *
 * A private app's fonts are the one exception: `@font-face` loads carry no
 * cookie, so a GET for a `.woff2|.woff|.ttf|.otf` path of an existing app is
 * let through when — and only when — what comes back is a font.
 *
 * What passes goes to the bridge's data plane, `/app/<port>/…`, which only the
 * gate reaches, with every front-door credential stripped. What comes back
 * gets the app policy (app-policy.ts) and, for HTML and CSS, the path fixes
 * (fidelity.ts). Every exchange is tracked by what let it in, so taking that
 * away — stopping sharing, a new passcode, expiry, removing the app, ending a
 * session — cuts it at once.
 */

/** HTML or CSS larger than this streams through unedited. */
export const MAX_REWRITE = 2 * 1024 * 1024;
/**
 * Pages being edited at once. Each holds its page a few times over (as it
 * came, decoded, as text, edited), so this many at MAX_REWRITE stay well
 * inside the gate's memory cap; a page past it is passed on unedited.
 */
export const MAX_REWRITES = 6;
/** A passcode form is small. */
const MAX_FORM = 4 * 1024;
/** The expiry sweep: links that run out are made private this often. */
export const EXPIRY_SWEEP_MS = 30_000;

export interface AppRoute {
  id: string;
  /** The path after `/a/<id>`, starting with `/`. */
  rest: string;
  query: string | null;
}

type Admission =
  /** A session or device token, directly. */
  | { as: "owner"; subject: Subject }
  /** A grant minted from a session, a token or a passcode. */
  | { as: "grant"; subject: GrantSubject }
  | { as: "public" };

/** How an open exchange was let in, and so what cuts it. */
interface Live {
  appId: string;
  /** `public` and `passcode` are cut when sharing stops; the owner's when their session or token ends. */
  kind: "owner" | "passcode" | "public";
  /** `session:<id>` or `token:<id>` for the owner's. */
  subject: string | null;
  close(): void;
}

function subjectKey(a: Admission): string | null {
  if (a.as === "owner") return `${a.subject.kind}:${a.subject.id}`;
  if (a.as === "grant" && a.subject.kind !== "passcode") return `${a.subject.kind}:${a.subject.id}`;
  return null;
}

function liveKind(a: Admission): Live["kind"] {
  if (a.as === "public") return "public";
  if (a.as === "grant" && a.subject.kind === "passcode") return "passcode";
  return "owner";
}

/** A page load, as opposed to a script's request. */
function isNavigation(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string") return mode === "navigate";
  return String(req.headers.accept ?? "").includes("text/html");
}

/** Whether the answer is likely HTML or CSS, and so worth asking for uncompressed. */
function mayBeEditable(req: IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe" || dest === "frame" || dest === "style") return true;
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/html") || accept.includes("text/css");
}

function flatten(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [n, v] of pairs) out.push(n, v);
  return out;
}

/**
 * A compressed page, decoded — never to more than MAX_REWRITE: a few KiB of
 * gzip can say gigabytes, and the gate would hold them all. `null` when it
 * cannot be read or would be larger; the page then goes on as it came.
 */
export function decode(body: Buffer, encoding: string | undefined): Buffer | null {
  const e = (encoding ?? "").trim().toLowerCase();
  const opts = { maxOutputLength: MAX_REWRITE };
  try {
    if (e === "" || e === "identity") return body;
    if (e === "gzip" || e === "x-gzip") return zlib.gunzipSync(body, opts);
    if (e === "br") return zlib.brotliDecompressSync(body, opts);
    if (e === "deflate") {
      try {
        return zlib.inflateSync(body, opts);
      } catch (err) {
        if (err instanceof RangeError) return null;
        return zlib.inflateRawSync(body, opts);
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Keep-alive to the data plane, without a socket timeout: an app's long poll
// or event stream is its own business.
const agent = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 32 });
const CONNECT_TIMEOUT_MS = 10_000;

export interface AppGatewayDeps {
  core: GateCore;
  registry: AppRegistry;
  grants: Grants;
  dataPlane: Upstream;
  /** Refused `/a/` lookups, per client address. */
  probes: WindowLimiter;
  /**
   * Wrong passcodes per app, from every address together: guesses spread over
   * many addresses still meet this.
   */
  passcodeMisses: WindowLimiter;
  forwarded(info: RequestInfo): Forwarded;
}

export class AppGateway {
  private readonly live = new Map<string, Set<Live>>();
  /** Pages being read whole to be edited, now. */
  private rewriting = 0;
  private readonly sweep: ReturnType<typeof setInterval>;
  private styles: string | null = null;

  constructor(private readonly deps: AppGatewayDeps) {
    deps.registry.onChange((c) => this.onAppChange(c));
    deps.core.auth.onEnded((e) => this.onEnded(e));
    this.sweep = setInterval(() => {
      void deps.registry.expire().catch((err: unknown) => console.error("[gate] app expiry sweep failed", err));
    }, EXPIRY_SWEEP_MS);
    this.sweep.unref();
  }

  close(): void {
    clearInterval(this.sweep);
  }

  // --- who is connected, and cutting them off ----------------------------------

  private track(entry: Live): () => void {
    let set = this.live.get(entry.appId);
    if (!set) this.live.set(entry.appId, (set = new Set()));
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0 && this.live.get(entry.appId) === set) this.live.delete(entry.appId);
    };
  }

  private cut(appId: string, which: (l: Live) => boolean): void {
    for (const l of [...(this.live.get(appId) ?? [])]) {
      if (!which(l)) continue;
      try {
        l.close();
      } catch {
        // already gone
      }
    }
  }

  private onAppChange(c: AppChange): void {
    if (c.kind === "removed") this.cut(c.id, () => true);
    else if (c.kind === "unshared") this.cut(c.id, (l) => (c.public && l.kind === "public") || (c.passcode && l.kind === "passcode"));
  }

  private onEnded(e: Ended): void {
    const ended = (key: string | null): boolean => {
      if (key === null || !key.startsWith(`${e.kind}:`)) return false;
      const id = key.slice(e.kind.length + 1);
      return "ids" in e ? e.ids.includes(id) : id !== e.allBut;
    };
    for (const id of [...this.live.keys()]) this.cut(id, (l) => ended(l.subject));
  }

  /** How many exchanges are open for an app (tests). */
  openCount(appId: string): number {
    return this.live.get(appId)?.size ?? 0;
  }

  // --- admission ------------------------------------------------------------------

  private grantSubjectValid(s: GrantSubject, app: AppRecord): boolean {
    const { auth } = this.deps.core;
    if (s.kind === "session") return auth.sessionIsLive(s.id);
    if (s.kind === "token") return auth.tokenExists(s.id);
    return this.deps.registry.isPublic(app) === "passcode" && app.visibility.epoch === s.epoch;
  }

  /** The app, if it exists and may be served at all. */
  private lookup(id: string): AppRecord | undefined {
    const app = this.deps.registry.get(id);
    if (!app || this.deps.registry.isInfraPort(app.port)) return undefined;
    return app;
  }

  private admit(req: IncomingMessage, app: AppRecord): { admission: Admission; hasGrant: boolean } | null {
    const now = this.deps.core.now();
    for (const value of grantValues(req.headers.cookie)) {
      const g = this.deps.grants.verify(value, now);
      if (g && g.appId === app.id && this.grantSubjectValid(g.subject, app)) {
        return { admission: { as: "grant", subject: g.subject }, hasGrant: true };
      }
    }
    const subject = this.deps.core.authenticate(req);
    if (subject) return { admission: { as: "owner", subject }, hasGrant: false };
    if (this.deps.registry.isPublic(app) === "link") return { admission: { as: "public" }, hasGrant: false };
    return null;
  }

  /** The uniform refusal: sign in for a page load, `404` for anything else; `429` once an address has probed too much. */
  private refuse(req: IncomingMessage, res: ServerResponse, info: RequestInfo, route: AppRoute): void {
    const wait = this.deps.probes.take(info.key);
    if (wait !== null) {
      this.plain(res, 429, "too many requests for apps that are not there", { "retry-after": String(Math.ceil(wait / 1000)) });
      return;
    }
    if (isNavigation(req)) {
      const next = `/a/${route.id}${route.rest}${route.query === null ? "" : `?${route.query}`}`;
      this.plain(res, 302, "sign in first", { location: `/login?next=${encodeURIComponent(isStrictPath(`/a/${route.id}${route.rest}`) ? next : `/a/${route.id}/`)}` });
      return;
    }
    this.plain(res, 404, "not found");
  }

  private plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": APP_SANDBOX,
      connection: "close",
      ...extra,
    };
    for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
    res.writeHead(status, headers);
    res.end(`${text}\n`);
  }

  // --- plain requests -----------------------------------------------------------------

  async handle(req: IncomingMessage, res: ServerResponse, route: AppRoute, info: RequestInfo): Promise<void> {
    // CORS preflights carry no cookie, so nothing can be decided from them;
    // they are answered the same for every id, known or not.
    if (isNullPreflight(req.method, req.headers)) {
      const headers = preflightHeaders(req.headers);
      for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const app = this.lookup(route.id);
    if (app && req.method === "POST" && route.rest === `${RESERVED}/unlock`) return this.unlock(req, res, route, app, info);

    const admitted = app ? this.admit(req, app) : null;
    if (!app || !admitted) {
      if (app && this.deps.registry.isPublic(app) === "passcode" && isNavigation(req)) {
        return this.passcodePage(res, app, route, null, 0, 200);
      }
      if (app && req.method === "GET" && FONT_PATH.test(route.rest)) {
        return this.forward(req, res, route, app, info, { fontOnly: true, admission: null, grant: null });
      }
      return this.refuse(req, res, info, route);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") && !appOriginAllowed(req.headers)) {
      this.plain(res, 403, "request refused: it did not come from this app");
      return;
    }

    // The owner's page load: mint the grant its own requests will carry.
    let grant: string | null = null;
    const { admission } = admitted;
    if (admission.as === "owner" && !admitted.hasGrant && isNavigation(req)) {
      const subject: GrantSubject = { kind: admission.subject.kind, id: admission.subject.id };
      const value = await this.deps.grants.mint({ appId: app.id, subject, expiresAt: this.deps.core.now() + OWNER_GRANT_MS });
      grant = grantCookie(app.id, value, OWNER_GRANT_MS);
    }

    if (route.rest === `${RESERVED}/shim.js` && (req.method === "GET" || req.method === "HEAD")) {
      return this.shim(req, res, app, grant);
    }
    return this.forward(req, res, route, app, info, { fontOnly: false, admission, grant });
  }

  private shim(req: IncomingMessage, res: ServerResponse, app: AppRecord, grant: string | null): void {
    const body = Buffer.from(shimSource(`/a/${app.id}`), "utf8");
    let pairs: Array<[string, string]> = [
      ["Content-Type", "text/javascript; charset=utf-8"],
      ["Content-Length", String(body.length)],
      ["Cache-Control", "no-cache"],
    ];
    pairs = appResponseHeaders(pairs, this.policy(app, req));
    for (const [n, v] of SECURITY_HEADERS) pairs.push([n, v]);
    if (grant) pairs.push(["Set-Cookie", grant]);
    res.writeHead(200, flatten(pairs));
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private policy(app: AppRecord, req: IncomingMessage): PolicyContext {
    return { prefix: `/a/${app.id}`, port: app.port, origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined };
  }

  /** The upstream target on the data plane. */
  private target(app: AppRecord, route: AppRoute): string {
    const pathPart = app.keepPrefix ? `/a/${app.id}${route.rest}` : route.rest;
    return `/app/${app.port}${pathPart}${route.query === null ? "" : `?${route.query}`}`;
  }

  private extraHeaders(app: AppRecord): Record<string, string> {
    return { "x-agentbox-prefix": `/a/${app.id}`, "x-agentbox-keep-prefix": app.keepPrefix ? "1" : "0" };
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    route: AppRoute,
    app: AppRecord,
    info: RequestInfo,
    opts: { fontOnly: boolean; admission: Admission | null; grant: string | null },
  ): void {
    const headers = { ...forwardRequestHeaders(req, this.deps.forwarded(info)), ...this.extraHeaders(app) };
    const edit = app.compat === "auto" && !opts.fontOnly;
    if (edit && mayBeEditable(req)) headers["accept-encoding"] = "identity";
    const upReq = http.request({
      host: this.deps.dataPlane.host,
      port: this.deps.dataPlane.port,
      method: req.method,
      path: this.target(app, route),
      headers,
      agent,
    });

    const untrack = this.track({
      appId: app.id,
      kind: opts.admission ? liveKind(opts.admission) : "public",
      subject: opts.admission ? subjectKey(opts.admission) : null,
      close: () => {
        upReq.destroy();
        res.destroy();
      },
    });
    res.once("close", () => {
      untrack();
      if (!res.writableFinished) upReq.destroy();
    });

    const connectTimer = setTimeout(() => upReq.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    upReq.once("socket", (s) => {
      if (!s.connecting) clearTimeout(connectTimer);
      else s.once("connect", () => clearTimeout(connectTimer));
    });

    upReq.on("response", (upRes) => {
      clearTimeout(connectTimer);
      if (opts.fontOnly && !isFontType(upRes.headers["content-type"])) {
        upRes.resume();
        this.plain(res, 404, "not found");
        return;
      }
      let pairs = appResponseHeaders(filterResponseHeaders(upRes), this.policy(app, req));
      if (opts.grant) pairs.push(["Set-Cookie", opts.grant]);
      const status = upRes.statusCode ?? 502;
      let kind = edit && req.method !== "HEAD" && status !== 204 && status !== 304 && status >= 200 ? editableType(upRes.headers["content-type"]) : null;
      // Too many pages being edited at once: this one goes on unedited
      // rather than the gate holding more than it can.
      if (kind && this.rewriting >= MAX_REWRITES) kind = null;
      if (!kind) {
        res.writeHead(status, upRes.statusMessage, flatten(pairs));
        pipeline(upRes, res, () => {});
        return;
      }
      // HTML or CSS: read it whole (up to a bound), edit it, send it.
      this.rewriting += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.rewriting -= 1;
      };
      res.once("close", release);
      const chunks: Buffer[] = [];
      let size = 0;
      let streaming = false;
      upRes.on("data", (c: Buffer) => {
        if (streaming) return;
        size += c.length;
        chunks.push(c);
        if (size > MAX_REWRITE) {
          // Too big to hold: send it on as it came, unedited.
          streaming = true;
          upRes.pause();
          res.writeHead(status, upRes.statusMessage, flatten(pairs.filter(([n]) => n.toLowerCase() !== "content-length")));
          for (const b of chunks) res.write(b);
          chunks.length = 0;
          release();
          upRes.removeAllListeners("data");
          upRes.removeAllListeners("end");
          pipeline(upRes, res, () => {});
        }
      });
      upRes.on("end", () => {
        if (streaming) return;
        const raw = Buffer.concat(chunks);
        const encoding = upRes.headers["content-encoding"];
        const plainBody = decode(raw, typeof encoding === "string" ? encoding : undefined);
        if (plainBody === null) {
          // An encoding the gate cannot read, or one that decodes to more than
          // it will hold: pass it on as it is.
          release();
          res.writeHead(status, upRes.statusMessage, flatten(pairs));
          res.end(raw);
          return;
        }
        // latin1 maps every byte to one character and back, so whatever the
        // page's charset, everything the edit does not touch survives exactly.
        const text = plainBody.toString("latin1");
        const prefix = `/a/${app.id}`;
        let edited: string;
        let hint: string | null = null;
        if (kind === "html") {
          const r = rewriteHtml(text, { prefix });
          edited = r.html;
          hint = r.hint;
        } else {
          edited = rewriteCss(text, prefix);
        }
        const body = Buffer.from(edited, "latin1");
        // The validators named the app's bytes, not these: a revalidation must
        // not answer "unchanged" for an edit made under other settings (the
        // path fixes turned off, say).
        pairs = pairs.filter(([n]) => {
          const l = n.toLowerCase();
          return l !== "content-length" && l !== "content-encoding" && l !== "content-md5" && l !== "etag" && l !== "last-modified";
        });
        pairs.push(["Content-Length", String(body.length)]);
        if (hint) pairs.push([HINT_HEADER, hint]);
        release();
        res.writeHead(status, upRes.statusMessage, flatten(pairs));
        res.end(body);
      });
      upRes.on("error", () => {
        release();
        res.destroy();
      });
    });

    upReq.on("error", () => {
      clearTimeout(connectTimer);
      badGateway(res);
    });
    pipeline(req, upReq, () => {});
  }

  // --- passcodes -------------------------------------------------------------------------

  /** The sign-in page's tokens and rules, inlined for the passcode page. */
  private passcodeStyles(): string {
    if (this.styles !== null) return this.styles;
    const read = (name: string): string => {
      try {
        return fs.readFileSync(path.join(this.deps.core.config.staticDir, name), "utf8");
      } catch {
        return "";
      }
    };
    // No web font: from the page's opaque origin it would be a cross-origin load.
    const css = `${read("tokens.css")}\n${read("login.css")}`.replace(/@font-face\s*{[^}]*}/g, "").replace(/<\//g, "<\\/");
    this.styles = css;
    return css;
  }

  private passcodePage(
    res: ServerResponse,
    app: AppRecord,
    route: AppRoute,
    error: PasscodeView["error"],
    retryAfterMs: number,
    status: number,
    next?: string,
  ): void {
    const html = renderPasscode({
      name: app.name,
      action: `/a/${app.id}${RESERVED}/unlock`,
      next: next ?? this.safeNext(app, `/a/${app.id}${route.rest}${route.query === null ? "" : `?${route.query}`}`),
      error,
      retryAfterMs,
      styles: this.passcodeStyles(),
    });
    const body = Buffer.from(html, "utf8");
    const headers: Array<readonly [string, string]> = [
      ["Content-Type", "text/html; charset=utf-8"],
      ["Content-Length", String(body.length)],
      ["Cache-Control", "no-store"],
      // The app's sandbox like everything under /a/, and a policy of its own
      // that allows nothing but its inline styles.
      ["Content-Security-Policy", APP_SANDBOX],
      ["Content-Security-Policy", PASSCODE_CSP],
      ...SECURITY_HEADERS,
    ];
    if (retryAfterMs > 0) headers.push(["Retry-After", String(Math.ceil(retryAfterMs / 1000))]);
    res.writeHead(status, flatten(headers));
    res.end(body);
  }

  /** Where a passcode sends you: somewhere in this app, or its root. */
  private safeNext(app: AppRecord, raw: string): string {
    const root = `/a/${app.id}/`;
    if (typeof raw !== "string" || raw.length > 2048 || /[^\x21-\x7e]/.test(raw)) return root;
    const pathOnly = raw.split("?")[0] ?? "";
    if (!(pathOnly === root.slice(0, -1) || pathOnly.startsWith(root)) || !isStrictPath(pathOnly)) return root;
    if (pathOnly.startsWith(`/a/${app.id}${RESERVED}/`)) return root;
    return raw;
  }

  private readForm(req: IncomingMessage): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_FORM) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const type = String(req.headers["content-type"] ?? "");
        try {
          if (type.startsWith("application/json")) {
            const v = JSON.parse(text) as Record<string, unknown>;
            resolve(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : ""])));
          } else {
            resolve(Object.fromEntries(new URLSearchParams(text)));
          }
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  /**
   * A passcode, checked like a sign-in: the same per-address limits, before
   * bcrypt. The passcode never goes further than this: it is the gate's
   * alone, and the request carrying it is not forwarded.
   */
  private async unlock(req: IncomingMessage, res: ServerResponse, route: AppRoute, app: AppRecord, info: RequestInfo): Promise<void> {
    // The passcode page's own form (an opaque page: `Origin: null`), or a
    // client that names no origin; never another site's form, which would
    // spend its visitors' budgets on guesses.
    if (!appOriginAllowed(req.headers)) {
      req.resume();
      this.plain(res, 403, "request refused: it did not come from this app");
      return;
    }
    const form = await this.readForm(req);
    if (this.deps.registry.isPublic(app) !== "passcode" || form === null) return this.refuse(req, res, info, route);
    const next = this.safeNext(app, form.next ?? "");
    const { passcodeMisses } = this.deps;
    const { passcodes } = this.deps.core;
    const refusal = passcodes.attempt(info.key);
    if (refusal) return this.passcodePage(res, app, route, refusal.reason, refusal.retryAfterMs, 429, next);
    // Checked, not spent: only a wrong passcode costs from the app's budget.
    const appWait = passcodeMisses.blocked(app.id);
    if (appWait !== null) {
      passcodes.success(info.key);
      return this.passcodePage(res, app, route, "app_busy", appWait, 429, next);
    }
    const epoch = app.visibility.epoch;
    const ok = await this.deps.core.passwords.verify(form.passcode ?? "", app.visibility.passcodeHash ?? null);
    // The passcode may have changed while it was being checked.
    if (!ok || app.visibility.epoch !== epoch || this.deps.registry.isPublic(app) !== "passcode") {
      passcodes.failure(info.key);
      passcodeMisses.take(app.id);
      console.warn(`[gate] app passcode refused from ${info.ip}`);
      return this.passcodePage(res, app, route, "invalid", 0, 401, next);
    }
    passcodes.success(info.key);
    const now = this.deps.core.now();
    const until = Math.min(now + PASSCODE_GRANT_MS, app.visibility.expiresAt ?? Number.POSITIVE_INFINITY);
    const value = await this.deps.grants.mint({ appId: app.id, subject: { kind: "passcode", epoch }, expiresAt: until });
    const headers: Record<string, string> = {
      location: next,
      "set-cookie": grantCookie(app.id, value, until - now),
      "cache-control": "no-store",
      "content-security-policy": APP_SANDBOX,
    };
    for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
    res.writeHead(303, headers);
    res.end();
  }

  // --- WebSockets ---------------------------------------------------------------------------

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: AppRoute, info: RequestInfo): void {
    const app = this.lookup(route.id);
    const admitted = app ? this.admit(req, app) : null;
    if (!app || !admitted) {
      const wait = this.deps.probes.take(info.key);
      return refuseUpgrade(socket, wait === null ? 404 : 429, wait === null ? "Not Found" : "Too Many Requests");
    }
    // The app's own page (Origin: null) or the box's own; never another site.
    if (!appOriginAllowed(req.headers)) return refuseUpgrade(socket, 403, "Forbidden");
    const { admission } = admitted;
    const untrack = this.track({
      appId: app.id,
      kind: liveKind(admission),
      subject: subjectKey(admission),
      close: () => socket.destroy(),
    });
    socket.once("close", untrack);

    const ctx = this.policy(app, req);
    const upReq = http.request({
      host: this.deps.dataPlane.host,
      port: this.deps.dataPlane.port,
      method: req.method,
      path: this.target(app, route),
      headers: { ...forwardRequestHeaders(req, this.deps.forwarded(info), true), ...this.extraHeaders(app) },
      agent: false,
    });
    const connectTimer = setTimeout(() => upReq.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    let upgraded = false;
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      clearTimeout(connectTimer);
      upgraded = true;
      if (socket.destroyed) {
        upSocket.destroy();
        return;
      }
      const pairs = appResponseHeaders(filterResponseHeaders(upRes, true), ctx).filter(
        ([n]) => n.toLowerCase() !== "content-security-policy",
      );
      let block = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Switching Protocols"}\r\n`;
      for (const [n, v] of pairs) block += `${n}: ${v}\r\n`;
      socket.write(`${block}\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.setNoDelay(true);
      const end = (): void => {
        socket.destroy();
        upSocket.destroy();
      };
      upSocket.on("error", end);
      socket.on("error", end);
      upSocket.on("close", end);
      socket.on("close", end);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upReq.on("response", (upRes) => {
      clearTimeout(connectTimer);
      const pairs = appResponseHeaders(filterResponseHeaders(upRes), ctx);
      pairs.push(["Connection", "close"]);
      let block = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ""}\r\n`;
      for (const [n, v] of pairs) block += `${n}: ${v}\r\n`;
      socket.write(`${block}\r\n`);
      pipeline(upRes, socket, () => {});
    });
    upReq.on("error", () => {
      clearTimeout(connectTimer);
      refuseUpgrade(socket, 502, "Bad Gateway");
    });
    const abandon = (): void => {
      if (!upgraded) upReq.destroy();
    };
    socket.on("error", abandon);
    socket.on("close", abandon);
    upReq.end();
  }
}
