import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, isAppId, toView, type AppRegistry } from "./apps.js";
import { normalizeIp, type ClientIpResolver } from "./client-ip.js";

/**
 * The sandbox-side app API, on its own listener (:7901), which the sandbox
 * reaches over the internal network and the proxy never forwards to. It is
 * how an agent registers the server it started — through the bridge's
 * `/api/apps` or `agentbox-preview` — and all it can do is what the sandbox
 * could do anyway: name a port on its own loopback.
 *
 *   POST   /apps {port, name?, cwd?, command?, pinned?, keepPrefix?}  → App (private, createdBy "agent")
 *   GET    /apps                                                     → App[]
 *   GET    /apps/:id                                                 → App
 *   PATCH  /apps/:id {name?, port?, cwd?, command?, pinned?, keepPrefix?, compat?} → App
 *   DELETE /apps/:id                                                 → 204
 *   GET    /apps/watch?since=<revision>&wait=<ms>                    → {revision, sharing}
 *
 * Visibility is not writable here, in any form: making an app public takes the
 * owner's session or device token, on the public side.
 */

const MAX_BODY = 64 * 1024;
/** How long a watch may be held open. */
const MAX_WAIT_MS = 30_000;

function send(res: ServerResponse, status: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AppError(413, "too_large", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new AppError(400, "bad_json", "the body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

const SETTABLE = ["port", "name", "cwd", "command", "pinned", "keepPrefix", "compat"];

/** The fields this side may set, and nothing else. */
function settable(body: Record<string, unknown>): Record<string, unknown> {
  if ("visibility" in body || "passcode" in body || "createdBy" in body || "id" in body) {
    throw new AppError(400, "not_settable", "visibility is the owner's to set, from a signed-in browser or the CLI");
  }
  return Object.fromEntries(Object.entries(body).filter(([k]) => SETTABLE.includes(k)));
}

export function createSandboxApi(registry: AppRegistry, clientIps: ClientIpResolver): http.Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the sandbox. The gate shares a network with the proxy too; nothing
    // arriving from it is the sandbox, whatever it asks for. (A proxy on
    // loopback is a test harness standing in for both; in the stack the proxy
    // is a container of its own and never the gate's loopback.)
    const peer = normalizeIp(req.socket.remoteAddress ?? "");
    if (clientIps.resolve(req).viaProxy && peer !== "127.0.0.1" && peer !== "::1") {
      return send(res, 403, { error: "forbidden" });
    }
    const url = new URL(req.url ?? "/", "http://gate");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "apps" || parts.length > 2) return send(res, 404, { error: "not found" });

    if (parts.length === 1) {
      if (req.method === "GET") return send(res, 200, registry.list().map(toView));
      if (req.method === "POST") {
        const app = await registry.create(settable(await readJson(req)), "agent");
        return send(res, 201, toView(app));
      }
      return send(res, 405, { error: "method not allowed" });
    }

    const id = parts[1] as string;
    if (id === "watch" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "-1");
      const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(url.searchParams.get("wait") ?? MAX_WAIT_MS) || 0));
      if (Number.isInteger(since) && since === registry.revision && wait > 0) {
        let gone = false;
        res.once("close", () => (gone = true));
        await registry.waitForChange(since, wait);
        if (gone) return;
      }
      return send(res, 200, { revision: registry.revision, sharing: registry.sharing });
    }
    if (!isAppId(id)) return send(res, 404, { error: "no such app" });
    if (req.method === "GET") {
      const app = registry.get(id);
      return app ? send(res, 200, toView(app)) : send(res, 404, { error: "no such app" });
    }
    if (req.method === "PATCH") {
      const app = await registry.update(id, settable(await readJson(req)));
      return send(res, 200, toView(app));
    }
    if (req.method === "DELETE") {
      return (await registry.remove(id)) ? send(res, 204) : send(res, 404, { error: "no such app" });
    }
    return send(res, 405, { error: "method not allowed" });
  }

  const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 60_000 }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof AppError) send(res, err.status, { error: err.code, message: err.message });
      else {
        console.error("[gate] sandbox API failed", err);
        send(res, 500, { error: "internal error" });
      }
    });
  });
  return server;
}
