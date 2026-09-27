import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IDLE_MS, bearerToken, type Subject } from "./auth.js";
import { clearedSessionCookie, sessionCookie } from "./cookies.js";
import { cleanDeviceName, TooManyPending } from "./device.js";
import { infoOf, originOf, safeEqual, safeNext, type GateCore, type RequestInfo } from "./context.js";
import { isSafeMethod, isSameOriginRequest } from "./origin.js";
import { PAGE_CSP, loginMessage, renderDevices, renderLogin, type DeviceView, type LoginError } from "./pages.js";
import { hashPassword, passwordProblem } from "./password.js";
import { SECURITY_HEADERS } from "./proxy.js";
import { emptyTotp } from "./store.js";
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  otpauthUrl,
  qrSvg,
  verifyTotp,
} from "./totp.js";

/**
 * The gate's own routes: sign-in, the account API under `/_gate/*`, the
 * device-approval page and the CLI download. Proxied traffic never reaches
 * Fastify; the dispatcher in app.ts hands over only the paths the route table
 * marks as the gate's.
 *
 * Fresh credentials. The box's origin also serves what the sandbox controls —
 * the editor, the terminals, the bridge's app — so script from a compromised
 * sandbox can run with the owner's session. What would let it keep the box or
 * lock the owner out therefore needs the password in the request itself (and
 * a code, with two-factor on): approving a device, two-factor setup, confirm
 * and disable, the password (`current`), and revoking any device token but
 * the caller's own. Nothing is remembered between requests — no window, no
 * elevated session — so having typed the password once lends a script nothing.
 * Without the credentials: `403 {error: "password_required"}`. Every check
 * counts against the sign-in limits.
 */

const REMEMBER_SECONDS = 30 * 24 * 60 * 60;

/** Routes a client without a session must be able to reach (and so exempt from the Origin check). */
const NO_CSRF = new Set(["/_gate/device/start", "/_gate/device/poll"]);

declare module "fastify" {
  interface FastifyContextConfig {
    /** Who may call: anyone, a session or token, or a browser session only. */
    auth?: "none" | "any" | "session";
  }
  interface FastifyRequest {
    subject: Subject | null;
  }
}

const ASSETS: Record<string, string> = {
  "login.css": "text/css; charset=utf-8",
  "login.js": "text/javascript; charset=utf-8",
  "tokens.css": "text/css; charset=utf-8",
  "inter.woff2": "font/woff2",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truthy(v: unknown): boolean {
  return v === true || v === "1" || v === "on" || v === "true";
}

/** A plain HTML form post, as opposed to the page's script or an API client. */
function isForm(req: FastifyRequest): boolean {
  return String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded");
}

function body(req: FastifyRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

function retryAfter(reply: FastifyReply, ms: number): void {
  reply.header("retry-after", String(Math.max(1, Math.ceil(ms / 1000))));
}

/**
 * One of the gate's pages. `same-origin`, not `no-referrer`: a form posted from
 * a `no-referrer` page carries `Origin: null`, and the same-origin check would
 * have nothing to go on. Links off the box still send no referrer.
 */
function html(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("content-security-policy", PAGE_CSP)
    .header("referrer-policy", "same-origin")
    .send(page);
}

/** Why proving it is the owner failed. */
interface Refused {
  status: number;
  error: LoginError | "password_required";
  message: string;
  retryAfterMs: number;
}

export async function registerApi(app: FastifyInstance, core: GateCore): Promise<void> {
  const { config, store, auth, devices, limiter } = core;
  const twoFactorOn = (): boolean => store.data.totp.secret !== null;

  /**
   * The password — and a code, with two-factor on — checked like a sign-in:
   * rate-limited before bcrypt, and refused if the credentials changed while
   * it was being checked. `null` means proven.
   */
  async function proveOwner(info: RequestInfo, password: string, code: string): Promise<Refused | null> {
    const refusal = limiter.attempt(info.key);
    if (refusal) return { status: 429, error: refusal.reason, message: loginMessage(refusal.reason, refusal.retryAfterMs), retryAfterMs: refusal.retryAfterMs };
    const generation = store.data.generation;
    if (!(await core.passwords.verify(password, store.data.password?.hash ?? null))) {
      limiter.failure(info.key);
      return { status: 401, error: "invalid", message: "The password is not right.", retryAfterMs: 0 };
    }
    if (twoFactorOn()) {
      if (!code) return { status: 401, error: "code_required", message: loginMessage("code_required"), retryAfterMs: 0 };
      if (!(await acceptSecondFactor(core, code))) {
        limiter.failure(info.key);
        return { status: 401, error: "invalid_code", message: loginMessage("invalid_code"), retryAfterMs: 0 };
      }
    }
    if (store.data.generation !== generation) {
      return { status: 401, error: "invalid", message: "The password changed while this was being checked. Try again.", retryAfterMs: 0 };
    }
    limiter.success(info.key);
    return null;
  }

  /**
   * The owner's credentials, sent with this very request. `null` means proven;
   * nothing is kept, so the next sensitive request must prove it again.
   */
  async function freshCredentials(req: FastifyRequest, password: string, code: string): Promise<Refused | null> {
    if (password) return proveOwner(infoOf(req.raw), password, code);
    return {
      status: 403,
      error: "password_required",
      message: twoFactorOn()
        ? "Confirm it is you: enter your password and a two-factor code."
        : "Confirm it is you: enter your password.",
      retryAfterMs: 0,
    };
  }

  function refuseJson(reply: FastifyReply, r: Refused): FastifyReply {
    if (r.retryAfterMs > 0) retryAfter(reply, r.retryAfterMs);
    return reply.code(r.status).send({ error: r.error, message: r.message, twoFactor: twoFactorOn() });
  }

  app.decorateRequest("subject", null);

  // A plain form post is how the pages work with JavaScript off.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, raw, done) => {
    done(null, Object.fromEntries(new URLSearchParams(raw as string)));
  });

  app.addHook("onRequest", async (req, reply) => {
    req.subject = core.authenticate(req.raw);
    // Cross-site request forgery: a state-changing request riding the session
    // cookie must come from this origin. A bearer token is not ambient — a page
    // on another site cannot attach one — so it is exempt, and so are the two
    // unauthenticated device-login calls the CLI makes.
    const path = req.url.split("?")[0] ?? "";
    if (isSafeMethod(req.method) || NO_CSRF.has(path)) return;
    if (bearerToken(req.headers.authorization) !== null) return;
    if (!isSameOriginRequest(req.headers)) {
      if (isForm(req) && path === "/_gate/login") {
        return html(reply, 403, renderLogin({ next: "/", username: "", host: infoOf(req.raw).host, needCode: false, error: "cross_site", retryAfterMs: 0 }));
      }
      return reply.code(403).send({ error: "cross_site", message: "request refused: it did not come from this site" });
    }
  });

  app.addHook("preHandler", async (req, reply) => {
    const need = req.routeOptions.config.auth ?? "none";
    if (need === "none") return;
    if (!req.subject) return reply.code(401).header("x-agentbox-login", "/login").send({ error: "unauthorized" });
    if (need === "session" && req.subject.kind !== "session") {
      return reply.code(403).send({ error: "session_required", message: "this needs a signed-in browser, not a device token" });
    }
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [n, v] of SECURITY_HEADERS) if (!reply.hasHeader(n)) reply.header(n, v);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    // A refusal closes the connection, so a body still trickling in behind it
    // cannot hold the socket.
    if (reply.statusCode === 302 || reply.statusCode >= 400) reply.header("connection", "close");
    return payload;
  });

  // --- sign-in page and its assets ------------------------------------------

  app.get<{ Querystring: { next?: string } }>("/login", async (req, reply) => {
    const next = safeNext(req.query.next);
    if (req.subject?.kind === "session") return reply.code(302).header("location", next).send();
    return html(reply, 200, renderLogin({ next, username: "", host: infoOf(req.raw).host, needCode: false, error: null, retryAfterMs: 0 }));
  });

  app.get<{ Params: { name: string } }>("/login/assets/:name", async (req, reply) => {
    const type = ASSETS[req.params.name];
    if (!type) return reply.code(404).send({ error: "not found" });
    let data: Buffer;
    try {
      data = await fs.promises.readFile(path.join(config.staticDir, req.params.name));
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type(type).header("cache-control", "public, max-age=300").send(data);
  });

  // --- sign-in and sign-out ---------------------------------------------------

  app.post("/_gate/login", async (req, reply) => {
    const b = body(req);
    const form = isForm(req);
    const info = infoOf(req.raw);
    const username = str(b.username);
    const next = safeNext(b.next);

    const refuse = (status: number, error: LoginError, waitMs = 0): FastifyReply => {
      if (waitMs > 0) retryAfter(reply, waitMs);
      if (form) {
        const needCode = error === "code_required" || error === "invalid_code";
        return html(reply, status, renderLogin({ next, username, host: info.host, needCode, error, retryAfterMs: waitMs }));
      }
      const payload: Record<string, unknown> = { error, message: loginMessage(error, waitMs) };
      if (waitMs > 0) payload.retryAfter = Math.ceil(waitMs / 1000);
      return reply.code(status).send(payload);
    };

    const password = str(b.password);
    if (!username || !password) return refuse(400, "bad_request");

    // Before bcrypt, always: a refused attempt costs a map lookup.
    const refusal = limiter.attempt(info.key);
    if (refusal) {
      console.warn(`[gate] sign-in refused (${refusal.reason}) from ${info.ip}`);
      return refuse(429, refusal.reason, refusal.retryAfterMs);
    }

    // Noted before the slow check: if the credentials change while it runs,
    // this sign-in used the old ones and must not outlive the change.
    const generation = store.data.generation;
    const stored = store.data.password;
    // Both halves are checked every time, so neither the answer nor its timing
    // says which one was wrong.
    const userOk = safeEqual(username, config.user);
    const passOk = await core.passwords.verify(password, stored?.hash ?? null);
    if (!stored) {
      limiter.failure(info.key);
      return refuse(503, "not_set_up");
    }
    if (!userOk || !passOk) {
      limiter.failure(info.key);
      console.warn(`[gate] sign-in failed from ${info.ip}`);
      return refuse(401, "invalid");
    }

    if (twoFactorOn()) {
      const code = str(b.code).trim();
      // Right password, second factor still to come. The attempt was counted;
      // it is not a failure.
      if (!code) return refuse(401, "code_required");
      if (!(await acceptSecondFactor(core, code))) {
        limiter.failure(info.key);
        console.warn(`[gate] two-factor code refused from ${info.ip}`);
        return refuse(401, "invalid_code");
      }
    }

    if (store.data.generation !== generation) {
      console.warn(`[gate] sign-in from ${info.ip} refused: the credentials changed while it was checked`);
      return refuse(401, "invalid");
    }

    limiter.success(info.key);
    const remember = truthy(b.remember);
    const { secret } = await auth.createSession({
      remember,
      ip: info.ip,
      userAgent: str(req.headers["user-agent"]),
    });
    console.log(`[gate] signed in from ${info.ip}${remember ? " (remembered)" : ""}`);
    reply.header("set-cookie", sessionCookie(secret, remember ? REMEMBER_SECONDS : null));
    if (form) return reply.code(303).header("location", next).send();
    return { ok: true, next };
  });

  app.post("/_gate/logout", async (req, reply) => {
    if (req.subject?.kind === "session") await auth.endSession(req.subject.id);
    reply.header("set-cookie", clearedSessionCookie());
    if (isForm(req)) return reply.code(303).header("location", "/login").send();
    return reply.code(204).send();
  });

  // --- the current session, and the other sessions -----------------------------

  app.get("/_gate/session", { config: { auth: "any" } }, async (req) => {
    const s = req.subject as Subject;
    if (s.kind === "token") {
      return { kind: "token", id: s.id, name: s.token.name, user: config.user, createdAt: s.token.createdAt };
    }
    const { session } = s;
    return {
      kind: "session",
      id: session.id,
      user: config.user,
      createdAt: session.createdAt,
      remember: session.remember,
      expiresAt: session.remember ? session.expiresAt : Math.min(session.expiresAt, session.lastSeenAt + IDLE_MS),
      twoFactor: twoFactorOn(),
    };
  });

  app.get("/_gate/sessions", { config: { auth: "session" } }, async (req) => {
    const current = (req.subject as Subject).id;
    return auth.listSessions().map((s) => ({
      id: s.id,
      current: s.id === current,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      remember: s.remember,
      ip: s.ip,
      userAgent: s.userAgent,
    }));
  });

  app.delete<{ Params: { id: string } }>("/_gate/sessions/:id", { config: { auth: "session" } }, async (req, reply) => {
    const ended = await auth.endSession(req.params.id);
    if (!ended) return reply.code(404).send({ error: "no such session" });
    if (req.params.id === (req.subject as Subject).id) reply.header("set-cookie", clearedSessionCookie());
    return reply.code(204).send();
  });

  app.delete<{ Querystring: { others?: string } }>("/_gate/sessions", { config: { auth: "session" } }, async (req, reply) => {
    if (req.query.others !== "1") return reply.code(400).send({ error: "say ?others=1 to end every other session" });
    const ended = await auth.endSessions((req.subject as Subject).id);
    return { ended };
  });

  // --- password ---------------------------------------------------------------

  // `current` is the password field here, and it is required.
  app.post("/_gate/password", { config: { auth: "session" } }, async (req, reply) => {
    const b = body(req);
    const info = infoOf(req.raw);
    // Checked first: refusing a weak new password needs no bcrypt, so it costs
    // no attempt.
    const next = str(b.next);
    const problem = passwordProblem(next);
    if (problem) return reply.code(400).send({ error: "weak", message: `The new password is not acceptable: ${problem}.` });
    const refused = await freshCredentials(req, str(b.current), str(b.code).trim());
    if (refused) return refuseJson(reply, refused.error === "invalid" ? { ...refused, message: "The current password is not right." } : refused);
    store.data.password = { hash: await hashPassword(next, config.bcryptCost), updatedAt: core.now() };
    store.data.generation += 1;
    // Changing the password ends every other session.
    const ended = await auth.endSessions((req.subject as Subject).id);
    console.log(`[gate] password changed from ${info.ip}; ended ${ended} other session(s)`);
    return { ok: true, endedSessions: ended };
  });

  // --- two-factor -------------------------------------------------------------

  app.post("/_gate/totp/setup", { config: { auth: "session" } }, async (req, reply) => {
    const b = body(req);
    const refused = await freshCredentials(req, str(b.password), str(b.code).trim());
    if (refused) return refuseJson(reply, refused);
    const totp = store.data.totp;
    if (totp.secret) return reply.code(409).send({ error: "already_enabled", message: "Two-factor is already on. Turn it off first to enrol a new device." });
    const secret = generateSecret();
    totp.pending = { secret, createdAt: core.now() };
    await store.save();
    // The account label an authenticator app shows: who, on which box.
    const url = otpauthUrl(secret, `${config.user}@${new URL(originOf(core, req.raw)).host}`);
    return { secret, otpauthUrl: url, qrSvg: qrSvg(url) };
  });

  app.post("/_gate/totp/confirm", { config: { auth: "session" } }, async (req, reply) => {
    const info = infoOf(req.raw);
    const b = body(req);
    const wait = core.totpConfirms.take(info.key);
    if (wait !== null) {
      retryAfter(reply, wait);
      return reply.code(429).send({ error: "rate", message: loginMessage("rate", wait) });
    }
    // The password again, as for setup; `code` here is the new authenticator's
    // (two-factor is not on yet, so no second factor is asked for).
    const refused = await freshCredentials(req, str(b.password), "");
    if (refused) return refuseJson(reply, refused);
    const totp = store.data.totp;
    if (totp.secret) return reply.code(409).send({ error: "already_enabled" });
    const pending = totp.pending;
    // An enrolment left unconfirmed for an hour is stale; start again.
    if (!pending || core.now() - pending.createdAt > 60 * 60_000) {
      return reply.code(409).send({ error: "no_enrolment", message: "Start two-factor setup again." });
    }
    const step = verifyTotp(pending.secret, str(b.code).trim(), core.now(), 0);
    if (step === null) return reply.code(400).send({ error: "invalid_code", message: loginMessage("invalid_code") });
    const recoveryCodes = generateRecoveryCodes();
    store.data.totp = {
      secret: pending.secret,
      enabledAt: core.now(),
      pending: null,
      lastStep: step,
      recoveryCodes: recoveryCodes.map(hashRecoveryCode),
    };
    store.data.generation += 1;
    // Changing two-factor ends every other session.
    const ended = await auth.endSessions((req.subject as Subject).id);
    console.log(`[gate] two-factor enabled from ${info.ip}; ended ${ended} other session(s)`);
    return { recoveryCodes };
  });

  app.delete("/_gate/totp", { config: { auth: "session" } }, async (req, reply) => {
    const info = infoOf(req.raw);
    const b = body(req);
    const refused = await freshCredentials(req, str(b.password), str(b.code).trim());
    if (refused) return refuseJson(reply, refused);
    store.data.totp = emptyTotp();
    store.data.generation += 1;
    const ended = await auth.endSessions((req.subject as Subject).id);
    console.log(`[gate] two-factor turned off from ${info.ip}; ended ${ended} other session(s)`);
    return reply.code(204).send();
  });

  // --- device login (the CLI) --------------------------------------------------

  app.post("/_gate/device/start", async (req, reply) => {
    const info = infoOf(req.raw);
    const wait = core.deviceStarts.take(info.key);
    if (wait !== null) {
      retryAfter(reply, wait);
      return reply.code(429).send({ error: "slow_down" });
    }
    const name = cleanDeviceName(body(req).name);
    if (!name) return reply.code(400).send({ error: "invalid_request", message: "name the device, e.g. {\"name\": \"laptop\"}" });
    try {
      const started = await devices.start(name, info.ip, info.key);
      return {
        ...started,
        verifyUrl: `${originOf(core, req.raw)}/settings/devices?code=${started.userCode}`,
      };
    } catch (err) {
      if (err instanceof TooManyPending) return reply.code(429).send({ error: "slow_down", message: err.message });
      throw err;
    }
  });

  // Answers follow RFC 8628: 200 with the token once, else 400 with
  // `authorization_pending`, `slow_down`, `access_denied` or `expired_token`.
  app.post("/_gate/device/poll", async (req, reply) => {
    const info = infoOf(req.raw);
    if (core.devicePolls.take(info.key) !== null) return reply.code(400).send({ error: "slow_down" });
    const deviceCode = str(body(req).deviceCode);
    if (!deviceCode) return reply.code(400).send({ error: "invalid_request" });
    const result = await devices.poll(deviceCode);
    if ("token" in result) {
      console.log(`[gate] device token collected from ${info.ip}`);
      return { token: result.token };
    }
    return reply.code(400).send(result);
  });

  app.get<{ Querystring: { code?: string } }>("/_gate/device/pending", { config: { auth: "session" } }, async (req, reply) => {
    const rec = devices.pending(str(req.query.code));
    if (!rec) return reply.code(404).send({ error: "no such login waiting" });
    return { userCode: rec.userCode, name: rec.name, ip: rec.ip, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
  });

  /** The approval page for `code`, as it stands for this session. */
  function devicesPage(req: FastifyRequest, code: string, error: string | null = null): DeviceView {
    const rec = code ? devices.pending(code) : null;
    return {
      pending: rec ? { userCode: rec.userCode, name: rec.name, ip: rec.ip, createdAt: rec.createdAt } : null,
      unknownCode: code && !rec ? code.slice(0, 16) : null,
      result: null,
      twoFactor: twoFactorOn(),
      error,
    };
  }

  // Approving gives a new device full access, so it needs the password (and a
  // code) in the same request: the page asks for them in its form. Denying
  // does not.
  app.post("/_gate/device/approve", { config: { auth: "session" } }, async (req, reply) => {
    const b = body(req);
    const code = str(b.userCode);
    const refused = await freshCredentials(req, str(b.password), str(b.code).trim());
    if (refused) {
      if (isForm(req)) {
        if (refused.retryAfterMs > 0) retryAfter(reply, refused.retryAfterMs);
        return html(reply, refused.status, renderDevices(devicesPage(req, code, refused.message)));
      }
      return refuseJson(reply, refused);
    }
    const rec = await devices.approve(code);
    if (rec) console.log(`[gate] device "${rec.name}" approved from ${infoOf(req.raw).ip}`);
    if (isForm(req)) {
      return html(reply, rec ? 200 : 404, renderDevices({ ...devicesPage(req, ""), result: rec ? "approved" : "gone" }));
    }
    if (!rec) return reply.code(404).send({ error: "no such login waiting" });
    return { ok: true };
  });

  app.post("/_gate/device/deny", { config: { auth: "session" } }, async (req, reply) => {
    const rec = await devices.deny(str(body(req).userCode));
    if (rec) console.log(`[gate] device "${rec.name}" denied from ${infoOf(req.raw).ip}`);
    if (isForm(req)) {
      return html(reply, rec ? 200 : 404, renderDevices({ ...devicesPage(req, ""), result: rec ? "denied" : "gone" }));
    }
    if (!rec) return reply.code(404).send({ error: "no such login waiting" });
    return { ok: true };
  });

  // --- device tokens ------------------------------------------------------------

  app.get("/_gate/tokens", { config: { auth: "any" } }, async (req) => {
    const current = req.subject?.kind === "token" ? req.subject.id : null;
    return auth.listTokens().map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      lastIp: t.lastIp,
      current: t.id === current,
    }));
  });

  /**
   * A device token may revoke itself (the CLI's logout) and nothing else;
   * revoking any other token takes a signed-in browser and the password, so a
   * stolen token cannot lock the owner's other devices out.
   */
  const revoke = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, id: string) => {
    const subject = req.subject as Subject;
    if (subject.kind === "token") {
      if (id !== subject.id) return reply.code(403).send({ error: "not_yours", message: "a device token can revoke only itself" });
    } else {
      const b = body(req);
      const refused = await freshCredentials(req, str(b.password), str(b.code).trim());
      if (refused) return refuseJson(reply, refused);
    }
    if (!(await auth.revokeToken(id))) return reply.code(404).send({ error: "no such token" });
    return reply.code(204).send();
  };
  app.delete<{ Params: { id: string } }>("/_gate/tokens/self", { config: { auth: "any" } }, async (req, reply) => {
    if (req.subject?.kind !== "token") return reply.code(400).send({ error: "only a device token has a self to revoke" });
    return revoke(req, reply, req.subject.id);
  });
  app.delete<{ Params: { id: string } }>("/_gate/tokens/:id", { config: { auth: "any" } }, async (req, reply) =>
    revoke(req, reply, req.params.id),
  );

  app.get("/_gate/version", { config: { auth: "any" } }, async () => ({ version: config.version }));

  // --- the device-approval page -----------------------------------------------

  app.get<{ Querystring: { code?: string } }>("/settings/devices", async (req, reply) => {
    if (req.subject?.kind !== "session") {
      const next = safeNext(req.raw.url);
      return reply.code(302).header("location", `/login?next=${encodeURIComponent(next)}`).send();
    }
    return html(reply, 200, renderDevices(devicesPage(req, str(req.query.code))));
  });

  // --- the CLI, served by the box itself (Phase E ships the files) ------------

  const CLI_FILES: Record<string, string> = {
    install: "text/x-shellscript; charset=utf-8",
    "agentbox.mjs": "text/javascript; charset=utf-8",
  };
  app.get<{ Params: { name: string } }>("/cli/:name", async (req, reply) => {
    const type = CLI_FILES[req.params.name];
    if (!type) return reply.code(404).send({ error: "not found" });
    try {
      const data = await fs.promises.readFile(path.join(config.cliDir, req.params.name));
      return reply.type(type).send(data);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));
}

/** A six-digit code or a recovery code, each usable once. */
async function acceptSecondFactor(core: GateCore, code: string): Promise<boolean> {
  const totp = core.store.data.totp;
  if (!totp.secret) return true;
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(totp.secret, code, core.now(), totp.lastStep);
    if (step === null) return false;
    totp.lastStep = step;
    await core.store.save();
    return true;
  }
  const idx = matchRecoveryCode(code, totp.recoveryCodes);
  if (idx === -1) return false;
  totp.recoveryCodes.splice(idx, 1);
  await core.store.save();
  console.log(`[gate] a recovery code was used; ${totp.recoveryCodes.length} left`);
  return true;
}
