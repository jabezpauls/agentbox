import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { infoOf, type GateCore } from "../context.js";
import { MACHINES, MAIN } from "../hosts.js";
import { isClaudeTokenShape } from "./claude-token.js";
import { JoinRefused } from "./joins.js";
import { StreamRefused } from "./link.js";
import { renderAdmin } from "./pages.js";
import { MACHINES_PAGE_CSP } from "./pages.js";
import { requireMachinesSession } from "./session.js";

/**
 * Joining machines, and the owner managing them.
 *
 * On the box's origin, unauthenticated, as the CLI's device login is: a node
 * asks to join (`/_gate/node/join/start`) and polls for its token
 * (`/_gate/node/join/poll`). Neither opens anything without the owner typing
 * the code the machine shows into the machines origin's Admin page.
 *
 * On the machines origin, with a machines session: the Admin page, and the
 * registry's API the machines UI reads — the machines, the pending
 * joins, approve (by typed code), deny, revoke, remove, the audit log.
 */

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function body(req: FastifyRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

export const JOIN_START_PATH = "/_gate/node/join/start";
export const JOIN_POLL_PATH = "/_gate/node/join/poll";

/** The box's origin: a node asks to join and collects its token. */
export function registerJoinRoutes(app: FastifyInstance, core: GateCore): void {
  const { joins } = core.machines;
  app.post(JOIN_START_PATH, { config: { hosts: MAIN } }, async (req, reply) => {
    const info = infoOf(req.raw);
    // Through the proxy only, as the link the token is for: the sandbox
    // reaching the gate's listener directly cannot put a machine in the list.
    if (!info.viaProxy) return reply.code(421).send({ error: "misdirected", message: "misdirected request" });
    const wait = core.machines.joinStarts.take(info.key);
    if (wait !== null) return reply.code(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "slow_down", message: "too many joins from your address; wait a minute" });
    const b = body(req);
    const rejoin = typeof b.rejoin === "object" && b.rejoin !== null ? (b.rejoin as { machineId?: unknown; token?: unknown }) : undefined;
    try {
      const started = await joins.start({ name: b.name, platform: b.platform, arch: b.arch, hostname: b.hostname, ip: info.ip, rejoin });
      console.log(`[gate] machine "${started.name}" asked to join from ${info.ip}`);
      return {
        ...started,
        // Where the owner types the code: the machines origin's Admin page, never a link with the code in it.
        approveAt: core.hosts ? `https://${core.hosts.machines}/admin` : null,
      };
    } catch (err) {
      if (err instanceof JoinRefused) return reply.code(err.status).send({ error: "refused", message: err.message });
      throw err;
    }
  });

  app.post(JOIN_POLL_PATH, { config: { hosts: MAIN } }, async (req, reply) => {
    const info = infoOf(req.raw);
    if (!info.viaProxy) return reply.code(421).send({ error: "misdirected", message: "misdirected request" });
    if (core.machines.joinPolls.take(info.key) !== null) return reply.code(429).send({ error: "slow_down" });
    const result = await joins.poll(str(body(req).joinCode), info.ip);
    if (result.status === "approved") console.log(`[gate] machine "${result.name}" collected its node token from ${info.ip}`);
    return result;
  });
}

function page(reply: FastifyReply, html: string): FastifyReply {
  return reply.code(200).type("text/html; charset=utf-8").header("content-security-policy", MACHINES_PAGE_CSP).send(html);
}

/** The machines origin (registered inside its hooks, machines/routes.ts). */
export function registerManageRoutes(m: FastifyInstance, core: GateCore): void {
  const { registry, joins, audit, links, router, claudeTokens } = core.machines;
  const session = { hosts: MACHINES, machines: "session" as const };
  const tokenGeneration = () => (claudeTokens.status().set ? claudeTokens.generation : null);
  const list = () => registry.all().map((r) => registry.view(r, links.isOnline(r.id), tokenGeneration()));

  m.get("/admin", { config: session }, async (req, reply) => {
    requireMachinesSession(req);
    await joins.prune();
    return page(
      reply,
      renderAdmin({
        host: core.hosts?.machines ?? "",
        box: core.hosts?.main ?? "",
        machines: list(),
        joins: joins.pending(),
        audit: audit.list(100),
        claudeToken: claudeTokens.status(),
      }),
    );
  });

  // --- the shared Claude Code token: write-only ------------------------------------

  const pushAll = () => {
    for (const r of registry.all()) if (r.state === "active") core.machines.pushClaudeToken(r.id);
  };

  // Whether one is set and when, never the token itself.
  m.get("/_gate/machines/claude-token", { config: session }, async () => ({
    ...claudeTokens.status(),
    stale: list().filter((v) => v.claudeTokenStale).map((v) => ({ id: v.id, name: v.name })),
  }));

  m.post("/_gate/machines/claude-token", { config: session }, async (req, reply) => {
    const token = body(req).token;
    if (!isClaudeTokenShape(token)) {
      return reply.code(400).send({ error: "bad_token", message: "That does not look like a token from `claude setup-token`." });
    }
    const replacing = claudeTokens.status().set;
    await claudeTokens.set(token);
    audit.record("claude-token", { ip: infoOf(req.raw).ip, detail: replacing ? "replaced" : "set" });
    pushAll();
    return { ok: true, ...claudeTokens.status() };
  });

  m.post("/_gate/machines/claude-token/remove", { config: session }, async (req) => {
    await claudeTokens.remove();
    audit.record("claude-token", { ip: infoOf(req.raw).ip, detail: "removed" });
    pushAll();
    return { ok: true, ...claudeTokens.status() };
  });

  m.post<{ Params: { id: string } }>("/_gate/machines/m/:id/opt-in", { config: session }, async (req, reply) => {
    const rec = registry.get(req.params.id);
    if (!rec || rec.state !== "active") return reply.code(404).send({ error: "not_found" });
    const on = body(req).claudeToken === true;
    await registry.optIn(rec, on);
    audit.record("opt-in", { machineId: rec.id, name: rec.name, ip: infoOf(req.raw).ip, detail: on ? "shared Claude token: on" : "shared Claude token: off" });
    core.machines.pushClaudeToken(rec.id);
    return { ok: true, optIns: rec.optIns };
  });

  // --- presence: the machine checks the owner is there ------------------------------

  const presenceError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof StreamRefused) return reply.code(err.status).send({ error: "unreachable", message: err.message });
    throw err;
  };

  // A fresh challenge from the machine, with its salt: a side effect on the machine, so a POST.
  m.post<{ Params: { id: string } }>("/_gate/machines/m/:id/presence/challenge", { config: session }, async (req, reply) => {
    const s = requireMachinesSession(req);
    const rec = registry.get(req.params.id);
    if (!rec || rec.state !== "active") return reply.code(404).send({ error: "not_found" });
    try {
      const r = await router.ask(rec.id, s.id, "POST", "/presence/challenge");
      // What the answer is bound to: this machines session and this machine.
      return reply.code(r.status).send({ ...r.json, session: s.id, machine: rec.id });
    } catch (err) {
      return presenceError(reply, err);
    }
  });

  m.post<{ Params: { id: string } }>("/_gate/machines/m/:id/presence", { config: session }, async (req, reply) => {
    const s = requireMachinesSession(req);
    const rec = registry.get(req.params.id);
    if (!rec || rec.state !== "active") return reply.code(404).send({ error: "not_found" });
    const b = body(req);
    try {
      const r = await router.ask(rec.id, s.id, "POST", "/presence/answer", { challenge: str(b.challenge), answer: str(b.answer) });
      const grant = r.json.grant;
      const expiresAt = r.json.expiresAt;
      if (r.status === 200 && typeof grant === "string" && typeof expiresAt === "number") {
        // Held here, presented on each stream for this session; never given to the page.
        router.setGrant(s.id, rec.id, grant, expiresAt);
        return { ok: true, expiresAt };
      }
      if (r.status !== 200) audit.record("presence", { machineId: rec.id, name: rec.name, ip: infoOf(req.raw).ip, detail: String(r.json.error ?? r.status) });
      const { grant: _g, ...rest } = r.json;
      void _g;
      return reply.code(r.status === 200 ? 502 : r.status).send(rest);
    } catch (err) {
      return presenceError(reply, err);
    }
  });

  m.get<{ Params: { id: string } }>("/_gate/machines/m/:id/presence", { config: session }, async (req) => {
    const s = requireMachinesSession(req);
    const expiresAt = router.grantExpiry(s.id, req.params.id);
    return { granted: expiresAt !== null, expiresAt };
  });

  m.get("/_gate/machines/list", { config: session }, async () => ({ machines: list() }));

  // --- apps on a machine (`agentbox-preview`), on the machine-apps origin ------------

  const appsOrigin = core.hosts ? `https://${core.hosts.machineApps}` : "";
  m.get<{ Params: { id: string } }>("/_gate/machines/m/:id/apps", { config: session }, async (req, reply) => {
    const rec = registry.get(req.params.id);
    if (!rec || rec.state !== "active") return reply.code(404).send({ error: "not_found" });
    return {
      apps: core.machines.apps.forMachine(rec.id).map((a) => ({ id: a.id, port: a.port, name: a.name, registeredAt: a.registeredAt, url: `${appsOrigin}/${a.id}/` })),
    };
  });

  // Opening one: a ticket for the machine-apps origin, which takes it for a grant (apps.ts). A POST: it mints.
  m.post<{ Params: { id: string; app: string } }>("/_gate/machines/m/:id/apps/:app/open", { config: session }, async (req, reply) => {
    const s = requireMachinesSession(req);
    const app = core.machines.apps.get(req.params.app);
    if (!app || app.machineId !== req.params.id || registry.get(app.machineId)?.state !== "active") return reply.code(404).send({ error: "not_found" });
    const ticket = core.machines.appTickets.issue(s.id, app.id);
    return { url: `${appsOrigin}/${app.id}/__agentbox/enter?t=${ticket}` };
  });

  m.get("/_gate/machines/joins", { config: session }, async () => {
    await joins.prune();
    return { joins: joins.pending() };
  });

  m.get("/_gate/machines/audit", { config: session }, async () => ({ events: audit.list(500) }));

  m.post("/_gate/machines/joins/approve", { config: session }, async (req, reply) => {
    const s = requireMachinesSession(req);
    const info = infoOf(req.raw);
    // The code is what proves the machine is the one in front of the owner:
    // guesses are few.
    const wait = core.machines.codeGuesses.take(s.id);
    if (wait !== null) return reply.code(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "slow_down", message: "too many codes tried; wait a few minutes" });
    const rec = await joins.approve(str(body(req).code), info.ip);
    if (!rec) return reply.code(404).send({ error: "no_such_code", message: "No machine is waiting with that code. Check the code on the machine's screen." });
    console.log(`[gate] machine join "${rec.name}" approved from ${info.ip}`);
    return { ok: true, name: rec.name };
  });

  m.post("/_gate/machines/joins/deny", { config: session }, async (req, reply) => {
    const rec = await joins.deny(str(body(req).id), infoOf(req.raw).ip);
    if (!rec) return reply.code(404).send({ error: "not_found", message: "That join is no longer waiting." });
    return { ok: true };
  });

  m.post<{ Params: { id: string } }>("/_gate/machines/m/:id/revoke", { config: session }, async (req, reply) => {
    const rec = await registry.revoke(req.params.id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    audit.record("revoked", { machineId: rec.id, name: rec.name, ip: infoOf(req.raw).ip, detail: "by the owner" });
    links.revoke(rec.id);
    router.forget(rec.id);
    core.machines.apps.forget(rec.id);
    console.log(`[gate] machine ${rec.name} revoked from ${infoOf(req.raw).ip}`);
    return { ok: true };
  });

  m.post<{ Params: { id: string } }>("/_gate/machines/m/:id/remove", { config: session }, async (req, reply) => {
    const rec = registry.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    // An active machine is revoked first, so it is told; then forgotten.
    if (rec.state === "active") return reply.code(409).send({ error: "active", message: "Revoke the machine before removing it." });
    links.disconnect(rec.id);
    router.forget(rec.id);
    core.machines.apps.forget(rec.id);
    await registry.remove(rec.id);
    audit.record("removed", { machineId: rec.id, name: rec.name, ip: infoOf(req.raw).ip });
    return { ok: true };
  });
}
