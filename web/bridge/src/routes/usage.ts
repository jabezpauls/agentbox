import type { FastifyInstance } from "fastify";
import { insideOnly } from "../local-caller.js";
import { paneIdOf, parseClaudeStatus } from "../usage/report.js";
import type { UsageService } from "../usage/service.js";

/** The path agentbox-status reports to. The gate refuses it from outside (web/gate/src/routes.ts). */
export const USAGE_REPORT_PATH = "/api/usage/report";

/**
 * Claude Code's status line JSON is a few kilobytes; this leaves room for
 * what later versions add without letting anything post megabytes.
 */
const REPORT_LIMIT = 256 * 1024;

/**
 * Usage meters: `GET /api/usage`, the current UsageSnapshot (the events socket
 * pushes the same as it changes), and `POST /api/usage/report`, where the
 * status line helper in each Claude Code session delivers what Claude Code
 * handed it. The report is for the sandbox alone — only a process inside may
 * say what the agents are doing — so it is refused unless it arrives over
 * loopback without an Origin or forwarding headers, and the gate does not
 * forward it at all.
 */
export function registerUsageRoutes(app: FastifyInstance, usage: UsageService): void {
  app.get("/api/usage", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return usage.refresh();
  });

  app.post<{ Body: Record<string, unknown> | undefined }>(
    USAGE_REPORT_PATH,
    { onRequest: insideOnly("usage reports come from the status line inside the sandbox"), bodyLimit: REPORT_LIMIT },
    async (req, reply) => {
      const body = req.body;
      const now = Date.now() / 1000;
      // The helper stamps its reading; a stamp from the future, or one that
      // took implausibly long to arrive, is the bridge's clock instead.
      const stamped = typeof body?.at === "number" && Number.isFinite(body.at) ? body.at : now;
      const at = stamped > now || stamped < now - 60 ? now : stamped;
      const report = parseClaudeStatus(body?.status, paneIdOf(body?.paneId), at);
      if (!report) return reply.code(400).send({ error: "expected { status: <Claude Code status line JSON with a session_id> }" });
      usage.ingest(report);
      return reply.code(204).send();
    },
  );
}
