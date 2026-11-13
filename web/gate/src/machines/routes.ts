import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clearedMachinesCookie, machinesCookie } from "../cookies.js";
import { HANDOFF_PATH, infoOf, type GateCore } from "../context.js";
import { MACHINES, MAIN } from "../hosts.js";
import { loginMessage } from "../pages.js";
import { machinesOriginOf } from "./headers.js";
import { MACHINES_ASSETS, MACHINES_PAGE_CSP, renderMachinesShell, renderSignin } from "./pages.js";
import { requireMachinesSession } from "./session.js";

/**
 * The machines origin's routes, and the box's one route into it.
 *
 * Signing in needs a live main session and the machines passphrase:
 *
 * 1. the machines origin, with no machines session, sends the tab to the box's
 *    `GET /_gate/machines/handoff` (through `/login` first if need be);
 * 2. that checks the main session, issues a nonce bound to it (handoff.ts)
 *    and sends the tab to the machines origin's `/signin?n=<nonce>`;
 * 3. the sign-in page posts the nonce and the passphrase, same-origin; the
 *    gate takes the nonce, checks its main session is still live and the
 *    passphrase (rate-limited as sign-ins are), and sets the machines session.
 *
 * Registered only while machines are on: off, every one of these paths is a
 * 404, on any host. The machines origin's request rules and headers are
 * applied before any of this runs (app.ts, headers.ts).
 */

declare module "fastify" {
  interface FastifyContextConfig {
    /** `session`: the route needs a machines session (machines origin only). */
    machines?: "session";
  }
}

const ASSETS: Record<string, string> = {
  "machines.js": "text/javascript; charset=utf-8",
  "login.css": "text/css; charset=utf-8",
  "tokens.css": "text/css; charset=utf-8",
  "inter.woff2": "font/woff2",
  "favicon.svg": "image/svg+xml",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function body(req: FastifyRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/** A page load rather than a script's request. */
function isNavigation(req: FastifyRequest): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string") return mode === "navigate";
  return String(req.headers.accept ?? "").includes("text/html");
}

function page(reply: FastifyReply, html: string): FastifyReply {
  return reply.code(200).type("text/html; charset=utf-8").header("content-security-policy", MACHINES_PAGE_CSP).send(html);
}

export async function registerMachines(app: FastifyInstance, core: GateCore): Promise<void> {
  app.decorateRequest("machinesSession", null);
  const names = core.hosts;
  if (names === null) return;
  const { config, store } = core;
  const machinesOrigin = machinesOriginOf(names.machines);
  const handoffUrl = `https://${names.main}${HANDOFF_PATH}`;

  // --- the box's origin: the way in ---------------------------------------------

  app.get(HANDOFF_PATH, { config: { hosts: MAIN } }, async (req, reply) => {
    // A signed-in browser, not a device token: this hands a person on.
    if (req.subject?.kind !== "session") {
      return reply.code(302).header("location", `/login?next=${encodeURIComponent(HANDOFF_PATH)}`).send();
    }
    const nonce = core.handoffs.issue(req.subject.id);
    return reply
      .code(302)
      .header("location", `${machinesOrigin}/signin?n=${nonce}`)
      .header("referrer-policy", "no-referrer")
      .send();
  });

  // --- the machines origin ------------------------------------------------------

  await app.register(async (m) => {
    m.addHook("onRequest", async (req, reply) => {
      // Its own session cookie and nothing else: a device token, a node token,
      // anything in Authorization is refused outright rather than ignored.
      if (req.headers.authorization !== undefined) {
        return reply.code(401).send({ error: "unauthorized", message: "the machines origin takes its own sign-in only" });
      }
      req.machinesSession = core.machinesSessions.authenticate(req.headers.cookie, infoOf(req.raw).ip);
    });

    m.addHook("preHandler", async (req, reply) => {
      if (req.routeOptions.config.machines !== "session" || req.machinesSession) return;
      // A tab with no machines session starts the handoff, top-level.
      if (req.method === "GET" && isNavigation(req)) return reply.code(302).header("location", handoffUrl).send();
      return reply.code(401).send({ error: "unauthorized", message: "sign in to machines first" });
    });

    // No CORS on this origin, ever, whoever tried to add it.
    m.addHook("onSend", async (_req, reply, payload) => {
      for (const name of Object.keys(reply.getHeaders())) {
        if (name.toLowerCase().startsWith("access-control-")) reply.removeHeader(name);
      }
      return payload;
    });

    m.get("/", { config: { hosts: MACHINES, machines: "session" } }, async (_req, reply) =>
      page(reply, renderMachinesShell({ host: names.machines })),
    );

    // No side effects: the nonce is only looked at here, and taken by the post.
    m.get<{ Querystring: { n?: string } }>("/signin", { config: { hosts: MACHINES } }, async (req, reply) => {
      if (req.machinesSession) return reply.code(302).header("location", "/").send();
      const n = str(req.query.n);
      return page(
        reply,
        renderSignin({
          host: names.machines,
          nonce: n && core.handoffs.peek(n) ? n : null,
          handoffUrl,
          notSetUp: store.data.machines.passphrase === null,
        }),
      );
    });

    m.post("/signin", { config: { hosts: MACHINES } }, async (req, reply) => {
      const info = infoOf(req.raw);
      const b = body(req);
      const nonce = str(b.nonce);
      const passphrase = str(b.passphrase);
      const restart = () =>
        reply.code(401).send({ error: "restart", message: "This sign-in has expired. Start again from the box." });

      // Taken whatever happens next: a nonce answers once. A refusal while the
      // main session lasts hands back a fresh one for the next try.
      const mainId = nonce ? core.handoffs.take(nonce) : null;
      if (mainId === null || !core.auth.sessionIsLive(mainId)) return restart();
      const again = () => core.handoffs.issue(mainId);

      if (!passphrase) return reply.code(400).send({ error: "bad_request", message: "Enter the machines passphrase.", nonce: again() });
      const refusal = core.machinesLimiter.attempt(info.key);
      if (refusal) {
        const secs = Math.max(1, Math.ceil(refusal.retryAfterMs / 1000));
        console.warn(`[gate] machines sign-in refused (${refusal.reason}) from ${info.ip}`);
        return reply
          .code(429)
          .header("retry-after", String(secs))
          .send({ error: refusal.reason, message: loginMessage(refusal.reason, refusal.retryAfterMs), retryAfter: secs, nonce: again() });
      }
      const stored = store.data.machines.passphrase;
      const generation = store.data.machines.generation;
      const ok = await core.passwords.verify(passphrase, stored?.hash ?? null);
      if (!stored) {
        core.machinesLimiter.failure(info.key);
        return reply.code(503).send({ error: "not_set_up", message: "No machines passphrase is set. On the server, run sudo ./scripts/agentbox machines enable." });
      }
      if (!ok) {
        core.machinesLimiter.failure(info.key);
        console.warn(`[gate] machines sign-in failed from ${info.ip}`);
        return reply.code(401).send({ error: "invalid", message: "That passphrase is not right.", nonce: again() });
      }
      // Changed while it was checked, or the box's session ended meanwhile.
      if (store.data.machines.generation !== generation || !core.auth.sessionIsLive(mainId)) return restart();
      core.machinesLimiter.success(info.key);
      const { secret } = await core.machinesSessions.create({ ip: info.ip, userAgent: str(req.headers["user-agent"]) });
      console.log(`[gate] signed in to machines from ${info.ip}`);
      reply.header("set-cookie", machinesCookie(secret));
      return { ok: true };
    });

    m.post("/signout", { config: { hosts: MACHINES } }, async (req, reply) => {
      if (req.machinesSession) await core.machinesSessions.end(req.machinesSession.id);
      reply.header("set-cookie", clearedMachinesCookie());
      return reply.code(204).send();
    });

    m.get("/_gate/machines/session", { config: { hosts: MACHINES, machines: "session" } }, async (req) => {
      const s = requireMachinesSession(req).record;
      return { id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt };
    });

    m.get<{ Params: { name: string } }>(`${MACHINES_ASSETS}/:name`, { config: { hosts: MACHINES } }, async (req, reply) => {
      const type = ASSETS[req.params.name];
      if (!type) return reply.code(404).send({ error: "not found" });
      let data: Buffer;
      try {
        data = await fs.promises.readFile(path.join(config.staticDir, req.params.name));
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.type(type).send(data);
    });
  });
}
