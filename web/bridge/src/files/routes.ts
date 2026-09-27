import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FileEntry } from "@workbench/shared";
import { describe, listDirectory, MAX_PAGE } from "./entries.js";
import { fsPath, parseQuery } from "./names.js";
import { sendFile, disposition, FILE_HEADERS } from "./raw.js";
import { fsError, FilesError } from "./roots.js";
import { searchNames } from "./search.js";
import type { FilesService } from "./service.js";
import { zipStream } from "./zip.js";

/**
 * `onSend` hook for routes that stream their request body: when the answer
 * goes out before the body was read — a refused chunk, a locked file — the
 * connection is closed rather than kept alive. The unread bytes would
 * otherwise sit in front of the client's next request on that socket, and a
 * client that retries idempotent requests on a confused connection (PUT is
 * idempotent) sends the next one twice.
 */
export async function closeIfBodyUnread(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  const body = req.body as { readableEnded?: boolean } | undefined;
  if (body && body.readableEnded === false) reply.header("connection", "close");
  return payload;
}

/** Report a failure the way every files route does: `{error, code?}` and a status. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = fsError(err, "path");
  if (e instanceof FilesError) {
    return reply.code(e.status).send(e.code ? { error: e.message, code: e.code } : { error: e.message });
  }
  throw e;
}

function one(q: Map<string, string[]>, key: string): string | undefined {
  return q.get(key)?.[0];
}

function flag(q: Map<string, string[]>, key: string): boolean {
  const v = one(q, key);
  return v !== undefined && v !== "0" && v !== "false";
}

function int(q: Map<string, string[]>, key: string, fallback: number, min: number, max: number): number {
  const v = Number(one(q, key));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}

type Body = Record<string, unknown> | undefined;

/**
 * `/api/files/*`: the file manager's API. Paths come in query strings (parsed
 * byte-exactly, see names.ts) for reads and in JSON bodies for writes; every
 * one goes through the service's {@link Roots} before anything touches disk.
 */
export function registerFilesRoutes(app: FastifyInstance, files: FilesService): void {
  const { roots } = files;

  const wrap =
    (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await fn(req, reply);
      } catch (err) {
        return sendError(reply, err);
      }
    };

  const git = async (dir: string, root: string) => files.git.lookupFor(dir, root);

  app.get(
    "/api/files/list",
    wrap(async (req) => {
      const q = parseQuery(req.raw.url ?? "");
      const dir = await roots.target(one(q, "path") ?? "");
      const st = await fsp.stat(fsPath(dir.real));
      if (!st.isDirectory()) throw new FilesError(409, `${dir.abs} is not a directory`, "not-a-directory");
      const lookup = await git(dir.abs, dir.root.path);
      return listDirectory(roots, dir, {
        hidden: flag(q, "hidden"),
        offset: int(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
        limit: int(q, "limit", MAX_PAGE, 1, MAX_PAGE),
        ...(lookup ? { git: lookup } : {}),
      });
    }),
  );

  app.get(
    "/api/files/stat",
    wrap(async (req) => {
      const q = parseQuery(req.raw.url ?? "");
      const ref = await roots.entry(one(q, "path") ?? "");
      const lookup = await git(path.dirname(ref.abs), ref.root.path);
      return describe(ref.abs, ref.fs, await roots.realRoot(ref.root), lookup);
    }),
  );

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/files/raw",
    handler: wrap(async (req, reply) => {
      const q = parseQuery(req.raw.url ?? "");
      const ref = await roots.target(one(q, "path"));
      const st = await fsp.stat(fsPath(ref.real));
      if (!st.isFile()) throw new FilesError(409, `${ref.abs} is not a file; download a folder as a zip`, "not-a-file");
      return sendFile(req, reply, ref.real, path.basename(ref.abs), st, flag(q, "inline"));
    }),
  });

  app.get(
    "/api/files/zip",
    wrap(async (req, reply) => {
      const q = parseQuery(req.raw.url ?? "");
      const paths = q.get("path") ?? [];
      if (paths.length === 0) throw new FilesError(400, "path required");
      const sources = [];
      for (const p of paths) {
        const ref = await roots.target(p);
        sources.push({ fs: ref.real, name: ref.abs === ref.root.path ? path.basename(ref.root.path) : path.basename(ref.abs) });
      }
      const name = one(q, "name") ?? (sources.length === 1 ? `${sources[0]!.name}.zip` : "files.zip");
      reply.headers(FILE_HEADERS);
      reply.header("content-type", "application/zip");
      reply.header("content-disposition", disposition("attachment", name));
      return reply.send(zipStream(sources, (err) => req.log.warn({ err }, "zip stream failed")));
    }),
  );

  app.get(
    "/api/files/search",
    wrap(async (req) => {
      const q = parseQuery(req.raw.url ?? "");
      const query = one(q, "q") ?? "";
      const dir = await roots.target(one(q, "path") ?? "");
      const rootReal = await roots.realRoot(dir.root);
      const found = await searchNames({
        dir: dir.real,
        query,
        limit: int(q, "limit", 50, 1, 200),
        ...(files.fd === undefined ? {} : { fd: files.fd }),
      });
      const entries: FileEntry[] = [];
      for (const real of found) {
        const abs = roots.present(dir.root, rootReal, real);
        try {
          entries.push(await describe(abs, real, rootReal));
        } catch {
          // gone since the search ran
        }
      }
      return entries;
    }),
  );

  app.post<{ Body: Body }>(
    "/api/files/write",
    { bodyLimit: 4 * 1024 * 1024 },
    wrap(async (req) => files.ops.write((req.body ?? {}) as Parameters<typeof files.ops.write>[0])),
  );
  app.post<{ Body: Body }>("/api/files/mkdir", wrap(async (req) => files.ops.mkdir((req.body ?? {}) as { path?: unknown })));
  app.post<{ Body: Body }>(
    "/api/files/move",
    wrap(async (req) => files.ops.move((req.body ?? {}) as Parameters<typeof files.ops.move>[0])),
  );
  app.post<{ Body: Body }>(
    "/api/files/copy",
    wrap(async (req) => files.ops.copy((req.body ?? {}) as Parameters<typeof files.ops.copy>[0])),
  );

  app.post<{ Body: Body }>(
    "/api/files/trash",
    wrap(async (req) => files.trash.trash((req.body as { paths?: unknown } | undefined)?.paths)),
  );
  app.get("/api/files/trash", wrap(async () => files.trash.list()));
  app.post<{ Params: { id: string }; Body: Body }>(
    "/api/files/trash/:id/restore",
    wrap(async (req) => {
      const { id } = req.params as { id: string };
      return files.trash.restore(id, (req.body as { to?: unknown } | undefined)?.to);
    }),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/files/trash/:id",
    wrap(async (req, reply) => {
      await files.trash.remove((req.params as { id: string }).id);
      return reply.code(204).send();
    }),
  );
  app.delete("/api/files/trash", wrap(async () => ({ removed: await files.trash.empty() })));

  app.post<{ Body: Body }>(
    "/api/files/uploads",
    wrap(async (req) => {
      const session = await files.uploads.start((req.body ?? {}) as { path?: unknown; size?: unknown; overwrite?: unknown });
      return { uploadId: session.id, ...session };
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/files/uploads/:id",
    wrap(async (req) => files.uploads.get((req.params as { id: string }).id)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/files/uploads/:id/finish",
    wrap(async (req) => files.uploads.finish((req.params as { id: string }).id)),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/files/uploads/:id",
    wrap(async (req, reply) => {
      await files.uploads.cancel((req.params as { id: string }).id);
      return reply.code(204).send();
    }),
  );

  // A chunk is raw bytes of any type: no parser may read it into memory
  // first, so this one route takes the request stream as it is.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    scope.addHook("onSend", closeIfBodyUnread);
    scope.put<{ Params: { id: string } }>(
      "/api/files/uploads/:id",
      wrap(async (req) => {
        const q = parseQuery(req.raw.url ?? "");
        const declared = req.headers["content-length"];
        const length = declared === undefined ? null : Number(declared);
        const body = (req.body as NodeJS.ReadableStream | undefined) ?? req.raw;
        return files.uploads.put(
          (req.params as { id: string }).id,
          one(q, "offset"),
          body as import("node:stream").Readable,
          Number.isFinite(length) ? length : null,
        );
      }),
    );
  });
}
