import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { infoOf, type GateCore } from "../context.js";
import { MACHINES, MAIN } from "../hosts.js";
import { JoinRefused } from "./joins.js";
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
 * registry's API the machines UI reads (phase 4) — the machines, the pending
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
  const { registry, joins, audit, links } = core.machines;
  const session = { hosts: MACHINES, machines: "session" as const };
  const list = () => registry.all().map((r) => registry.view(r, links.isOnline(r.id)));

  m.get("/admin", { config: session }, async (req, reply) => {
    requireMachinesSession(req);
    await joins.prune();
    return page(reply, renderAdmin({ host: core.hosts?.machines ?? "", box: core.hosts?.main ?? "", machines: list(), joins: joins.pending(), audit: audit.list(100) }));
  });

  m.get("/_gate/machines/list", { config: session }, async () => ({ machines: list() }));

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
    console.log(`[gate] machine ${rec.name} revoked from ${infoOf(req.raw).ip}`);
    return { ok: true };
  });

  m.post<{ Params: { id: string } }>("/_gate/machines/m/:id/remove", { config: session }, async (req, reply) => {
    const rec = registry.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    // An active machine is revoked first, so it is told; then forgotten.
    if (rec.state === "active") return reply.code(409).send({ error: "active", message: "Revoke the machine before removing it." });
    links.disconnect(rec.id);
    await registry.remove(rec.id);
    audit.record("removed", { machineId: rec.id, name: rec.name, ip: infoOf(req.raw).ip });
    return { ok: true };
  });
}
