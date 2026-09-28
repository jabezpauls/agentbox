import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EditorChannel } from "../editor.js";
import { sendError } from "../files/routes.js";
import type { FilesService } from "../files/service.js";
import { FilesError } from "../files/roots.js";

/** Headers a proxy adds: their presence means the request came through one. */
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];

/**
 * True when a socket to `/ws/editor` comes from inside the sandbox rather
 * than through the front door. The extension runs in code-server's extension
 * host, which shares the bridge's network namespace, so it connects over
 * loopback with a Node client that sends no `Origin`. A browser always sends
 * one on a websocket handshake, and a proxy — the gate — adds forwarding
 * headers, so neither passes even when the proxy itself is on loopback.
 */
export function isLocalEditor(req: FastifyRequest): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "::1" || /^(::ffff:)?127\./.test(addr);
  if (!loopback) return false;
  if (req.headers.origin !== undefined) return false;
  return !FORWARDED.some((h) => req.headers[h] !== undefined);
}

function localOnly(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (isLocalEditor(req)) {
    done();
    return;
  }
  void reply.code(403).send({ error: "the editor channel is only for the editor inside the sandbox" });
}

function position(raw: unknown, what: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new FilesError(400, `${what} must be a positive whole number`);
  return n;
}

/**
 * The editor channel: `/ws/editor`, which the `agentbox-connect` extension
 * holds open; `POST /api/editor/open {path, line?, column?, wait?, fresh?}`,
 * which asks it to open a file and answers whether it did; and
 * `POST /api/editor/theme {kind}`, the app's resolved light or dark, which
 * every editor window follows.
 */
export function registerEditorRoutes(app: FastifyInstance, channel: EditorChannel, files: FilesService): void {
  app.get("/ws/editor", { websocket: true, onRequest: localOnly }, (socket) => {
    channel.attach(socket);
  });

  app.get("/api/editor/status", () => ({ connected: channel.connected, theme: channel.theme }));

  app.post<{ Body: Record<string, unknown> | undefined }>("/api/editor/theme", async (req, reply) => {
    const kind = req.body?.kind;
    if (kind !== "light" && kind !== "dark") return reply.code(400).send({ error: "kind must be light or dark" });
    channel.setTheme(kind);
    return { theme: kind };
  });

  app.post<{ Body: Record<string, unknown> | undefined }>("/api/editor/open", async (req, reply) => {
    try {
      const body = req.body ?? {};
      // The file must exist inside a root; the editor is handed the path as
      // the caller named it, which is how it appears in the editor too.
      const ref = await files.roots.target(body.path);
      const line = position(body.line, "line");
      const column = position(body.column, "column");
      const wait = Math.min(30_000, Math.max(0, Number(body.wait) || 0));
      return await channel.open(ref.abs, {
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
        waitMs: wait,
        fresh: body.fresh === true,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
