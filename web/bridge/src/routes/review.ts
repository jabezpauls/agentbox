import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ReviewEndedBy } from "@workbench/shared";
import type { Config } from "../config.js";
import { injectAnnotator } from "../review/annotator.js";
import { KEY_PATTERN, NotFoundError, type IncomingComment, type ReviewStore } from "../review/store.js";

/** The longest a single long-poll request may park, in milliseconds. */
const MAX_WAIT_MS = 120_000;

interface KeyParams {
  key: string;
}

function wantedWait(raw: unknown): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_WAIT_MS);
}

/** Where a person should browse to see this session. */
function sessionUrl(config: Config, req: FastifyRequest, key: string): string {
  const origin = config.publicUrl ?? `${req.protocol}://${req.headers.host ?? "127.0.0.1"}`;
  return `${origin}${config.basePath}/review/${key}`;
}

/**
 * Review: the agent publishes an artifact, the browser comments on it, the
 * agent's blocking `poll` collects those comments.
 *
 * Three of these routes are the CLI's (`sessions`, the long poll, `end`), three
 * are the panel's, and one — `artifact` — is what the iframe loads. That last
 * one is the only route here that serves markup an agent wrote, so it is the
 * only one with a security posture worth restating: the response declares
 * itself sandboxed with an opaque origin, which holds even when it is opened as
 * a top-level tab and the iframe's own `sandbox` attribute no longer applies.
 */
export function registerReviewRoutes(app: FastifyInstance, config: Config, store: ReviewStore): void {
  const notFound = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "no such review session" });
    throw err;
  };

  const requireKey = (key: string, reply: FastifyReply): boolean => {
    // The key is a path segment on disk. Anything but the hash shape it is
    // generated with — `..`, a slash, an absolute path — is refused here rather
    // than relied upon to resolve harmlessly.
    if (KEY_PATTERN.test(key)) return true;
    reply.code(400).send({ error: "invalid session key" });
    return false;
  };

  app.post<{ Body: { file?: unknown; label?: unknown } }>("/api/review/sessions", async (req, reply) => {
    const file = typeof req.body?.file === "string" ? req.body.file : "";
    if (!file) return reply.code(400).send({ error: "file required" });
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    try {
      const { key, resumed, session } = await store.open(file, label);
      return { key, resumed, url: sessionUrl(config, req, key), session };
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(400).send({ error: `cannot read ${file}` });
      }
      throw err;
    }
  });

  app.get("/api/review/sessions", async () => store.list());

  app.get<{ Params: KeyParams }>("/api/review/:key", async (req, reply) => {
    if (!requireKey(req.params.key, reply)) return reply;
    try {
      return await store.get(req.params.key);
    } catch (err) {
      return notFound(reply, err);
    }
  });

  app.get<{ Params: KeyParams }>("/api/review/:key/artifact", async (req, reply) => {
    if (!requireKey(req.params.key, reply)) return reply;
    let html: string;
    try {
      html = await store.artifact(req.params.key);
    } catch (err) {
      return notFound(reply, err);
    }
    return reply
      // `sandbox` in a CSP gives the response an opaque origin with no scripts
      // of its own unless allowed: this is the copy of the guarantee that
      // survives the page being opened full screen, outside any iframe.
      .header("content-security-policy", "sandbox allow-scripts")
      .header("x-content-type-options", "nosniff")
      // The artifact is rewritten on every publish; never let a cache answer.
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(injectAnnotator(html));
  });

  app.post<{ Params: KeyParams; Body: { comments?: unknown; end?: unknown } }>(
    "/api/review/:key/feedback",
    async (req, reply) => {
      if (!requireKey(req.params.key, reply)) return reply;
      const comments = Array.isArray(req.body?.comments) ? (req.body.comments as IncomingComment[]) : [];
      const end = req.body?.end === true;
      try {
        return await store.post(req.params.key, comments, end);
      } catch (err) {
        return notFound(reply, err);
      }
    },
  );

  app.get<{ Params: KeyParams; Querystring: { wait?: string } }>(
    "/api/review/:key/feedback",
    async (req, reply) => {
      if (!requireKey(req.params.key, reply)) return reply;
      try {
        return await store.take(req.params.key, wantedWait(req.query.wait));
      } catch (err) {
        return notFound(reply, err);
      }
    },
  );

  app.post<{ Params: KeyParams; Body: { by?: unknown } }>("/api/review/:key/end", async (req, reply) => {
    if (!requireKey(req.params.key, reply)) return reply;
    const by: ReviewEndedBy = req.body?.by === "human" ? "human" : "agent";
    try {
      return await store.end(req.params.key, by);
    } catch (err) {
      return notFound(reply, err);
    }
  });
}
