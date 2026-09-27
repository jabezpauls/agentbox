import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { decodeComponent, decodeName, displayName, encodeSegment, fsPath } from "../names.js";
import { contentTypeFor, etagOf, loadedAsCode, sendFile } from "../raw.js";
import { fsError, FilesError, STATE_DIR, within, type Located } from "../roots.js";
import { closeIfBodyUnread, sendError } from "../routes.js";
import type { FilesService } from "../service.js";
import { copyTree, moveTree, noClobberRename, removeTree, scratchName } from "../tree.js";
import { LockManager, parseIf, parseTimeout, submittedTokens, type Lock } from "./locks.js";
import { child, DAV, escapeXml, parseXml, serialize, XmlError, type XmlElement } from "./xml.js";

export const DAV_PREFIX = "/api/dav";

/** The methods WebDAV adds to HTTP; Fastify must be told they carry bodies. */
export const DAV_METHODS = ["PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"] as const;

const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK";
/** A WebDAV request body is a few kilobytes; nothing a client sends comes near this. */
const MAX_XML = 256 * 1024;
const MS = "urn:schemas-microsoft-com:";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Files an operating system writes beside everything it touches (Finder's
 * `._` AppleDouble files and `.DS_Store`, Explorer's thumbnails). Deleting one
 * removes it for good instead of filling the trash.
 */
const OS_JUNK = /^(\.DS_Store|\._.+|Thumbs\.db|desktop\.ini)$/;

/** Live properties returned for `allprop`, in this order. */
const ALLPROP = [
  "displayname",
  "resourcetype",
  "getcontentlength",
  "getlastmodified",
  "creationdate",
  "getetag",
  "getcontenttype",
  "supportedlock",
  "lockdiscovery",
];
const QUOTA = ["quota-available-bytes", "quota-used-bytes"];

interface Resource {
  abs: string;
  st: Stats;
  locks: Lock[];
}

/** What a PROPFIND asked for. */
type Want = { mode: "allprop" } | { mode: "propname" } | { mode: "prop"; props: PropName[] };

interface PropName {
  ns: string;
  local: string;
}

/**
 * Fastify `rewriteUrl`: the router percent-decodes a path before matching it
 * and rejects one that is not valid UTF-8 — which a WebDAV path naming such a
 * file legitimately is. Only those requests are routed by a stand-in path; the
 * DAV handler reads the one it was really sent from `originalUrl` and decodes
 * it byte-exactly itself. Every other URL is left exactly as it came.
 */
export function routableUrl(req: { url?: string | undefined }): string {
  const url = req.url ?? "/";
  if (!url.startsWith(`${DAV_PREFIX}/`)) return url;
  const q = url.indexOf("?");
  try {
    decodeURI(q === -1 ? url : url.slice(0, q));
    return url;
  } catch {
    return `${DAV_PREFIX}/undecodable`;
  }
}

/** Read a small request body (XML) to a string, refusing anything large. */
async function readBody(req: FastifyRequest): Promise<string> {
  const stream = (req.body as Readable | undefined) ?? (req.raw.readableEnded ? null : req.raw);
  if (!stream) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_XML) throw new FilesError(413, "request body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(text: string): XmlElement | null {
  if (text.trim() === "") return null;
  try {
    return parseXml(text);
  } catch (err) {
    if (err instanceof XmlError) throw new FilesError(400, `malformed XML: ${err.message}`);
    throw err;
  }
}

function xml(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply
    .code(status)
    .header("content-type", "application/xml; charset=utf-8")
    .send(`<?xml version="1.0" encoding="utf-8"?>\n${body}`);
}

function davError(reply: FastifyReply, status: number, condition: string): FastifyReply {
  return xml(reply, status, `<D:error xmlns:D="DAV:">${condition}</D:error>`);
}

function propXml(p: PropName, value: string | null): string {
  const tag = p.ns === DAV ? `D:${p.local}` : `x:${p.local}`;
  const decl = p.ns === DAV ? "" : ` xmlns:x="${escapeXml(p.ns)}"`;
  return value === null || value === "" ? `<${tag}${decl}/>` : `<${tag}${decl}>${value}</${tag}>`;
}

function statusLine(code: number): string {
  const text: Record<number, string> = { 200: "OK", 403: "Forbidden", 404: "Not Found", 424: "Failed Dependency" };
  return `HTTP/1.1 ${code} ${text[code] ?? ""}`.trim();
}

/**
 * WebDAV over the workspace root, at `/api/dav/*`: enough of RFC 4918 (class
 * 1 and 2) for macOS Finder, GNOME's `gio mount` and `rclone` to browse, read
 * and write, which is what `agentbox mount` gives a laptop.
 *
 * It is the same files API underneath: the same confinement, and a DELETE
 * goes to the trash (operating-system litter aside). Two things differ from
 * the JSON API. Symlinks inside the root are shown as what they point at,
 * because DAV has no notion of a link, and links that lead out are not shown
 * at all. And dead properties are not stored: a `PROPPATCH` of one is refused,
 * except Windows' timestamps, which are applied where they mean something.
 *
 * Every GET carries the same sandbox and nosniff headers as the raw route, so
 * a browser pointed at `/api/dav/page.html` downloads it rather than running
 * it on the box's origin.
 */
export function registerDavRoutes(app: FastifyInstance, files: FilesService, locks = new LockManager()): void {
  const { roots } = files;
  const ws = roots.workspace;

  /** Map a raw request path under the prefix to an absolute path, strictly. */
  const toAbs = (rawPath: string): string => {
    if (!rawPath.startsWith(DAV_PREFIX)) throw new FilesError(400, "not a DAV path");
    const rest = rawPath.slice(DAV_PREFIX.length);
    if (rest !== "" && !rest.startsWith("/")) throw new FilesError(404, "not found");
    const names = rest
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeComponent(s, false));
    for (const n of names) {
      if (n === "." || n === ".." || n.includes("/") || n.includes("\0")) throw new FilesError(400, "bad path segment");
    }
    // The API's own state (trash, upload scratch) is not a file of the
    // user's: a mounted folder should not show it, and `rclone sync` to the
    // root must not try to delete it.
    if (names[0] === STATE_DIR) throw new FilesError(404, "not found");
    return path.join(ws.path, ...names);
  };

  const href = (abs: string, dir: boolean): string => {
    const rel = path.relative(ws.path, abs);
    const segs = rel === "" ? [] : rel.split(path.sep).map(encodeSegment);
    const joined = `${DAV_PREFIX}/${segs.join("/")}`;
    return dir && !joined.endsWith("/") ? `${joined}/` : joined;
  };

  // What the client sent, before any stand-in {@link routableUrl} routed it by.
  const rawPathOf = (req: FastifyRequest): string =>
    ((req.raw as { originalUrl?: string }).originalUrl ?? req.raw.url ?? "").split("?")[0] ?? "";

  const locate = (abs: string): Located => roots.locate(abs);

  /**
   * The real folders a path passes through, from the root down, refusing a
   * path that goes round a loop: through a link back to a folder it has
   * already been in, or up to one above it (`proj/up -> ..`). Such a path
   * names nothing new, and answering it would let a client that walks the
   * mount — every one does — descend for ever. Stops at the first part that
   * does not exist, so a path to be created is checked as far as it goes.
   */
  const loopCheck = async (abs: string): Promise<Set<string>> => {
    const rootReal = await roots.realRoot(ws);
    const seen = new Set([rootReal]);
    let prev = rootReal;
    let lexical = ws.path;
    for (const part of path.relative(ws.path, abs).split(path.sep).filter(Boolean)) {
      lexical = path.join(lexical, part);
      let real: string;
      try {
        real = decodeName(await fsp.realpath(fsPath(lexical), { encoding: "buffer" }));
      } catch {
        break;
      }
      if (seen.has(real) || within(prev, real)) throw new FilesError(404, "not found");
      seen.add(real);
      prev = real;
    }
    return seen;
  };

  /** Stat a resource the way DAV sees it: through links that stay inside. */
  const resource = async (abs: string): Promise<{ real: string; st: Stats } | null> => {
    try {
      const t = await roots.target(abs);
      return { real: t.real, st: await fsp.stat(fsPath(t.real)) };
    } catch (err) {
      if (err instanceof FilesError && err.status === 404) return null;
      throw err;
    }
  };

  const activeLock = (l: Lock): string =>
    `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:${l.scope}/></D:lockscope>` +
    `<D:depth>${l.depth === "0" ? "0" : "infinity"}</D:depth>${l.owner ? `<D:owner>${l.owner}</D:owner>` : ""}` +
    `<D:timeout>Second-${Math.max(0, Math.round((l.expires - Date.now()) / 1000))}</D:timeout>` +
    `<D:locktoken><D:href>${escapeXml(l.token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${href(l.path, false)}</D:href></D:lockroot></D:activelock>`;

  const live = (p: PropName, r: Resource, quota: () => Promise<{ free: number; used: number }>) => {
    if (p.ns !== DAV) return Promise.resolve(undefined);
    const dir = r.st.isDirectory();
    switch (p.local) {
      case "displayname":
        return Promise.resolve(escapeXml(r.abs === ws.path ? "workspace" : displayName(path.basename(r.abs))));
      case "resourcetype":
        return Promise.resolve(dir ? "<D:collection/>" : "");
      case "getcontentlength":
        return Promise.resolve(dir ? undefined : String(r.st.size));
      case "getlastmodified":
        return Promise.resolve(r.st.mtime.toUTCString());
      case "creationdate": {
        const born = r.st.birthtimeMs > 0 ? r.st.birthtime : r.st.mtime;
        return Promise.resolve(born.toISOString());
      }
      case "getetag":
        return Promise.resolve(escapeXml(etagOf(r.st)));
      case "getcontenttype":
        return Promise.resolve(dir ? undefined : escapeXml(contentTypeFor(r.abs)));
      case "supportedlock":
        return Promise.resolve(
          ["exclusive", "shared"]
            .map((s) => `<D:lockentry><D:lockscope><D:${s}/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>`)
            .join(""),
        );
      case "lockdiscovery":
        return Promise.resolve(r.locks.map(activeLock).join(""));
      case "quota-available-bytes":
        return quota().then((q) => String(q.free));
      case "quota-used-bytes":
        return quota().then((q) => String(q.used));
      default:
        return Promise.resolve(undefined);
    }
  };

  async function* multistatus(
    resources: AsyncIterable<Resource>,
    want: Want,
  ): AsyncGenerator<string> {
    yield `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">`;
    let q: Promise<{ free: number; used: number }> | null = null;
    const quota = () =>
      (q ??= fsp.statfs(fsPath(ws.path)).then((s) => ({ free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize })));
    for await (const r of resources) {
      let out = `<D:response><D:href>${href(r.abs, r.st.isDirectory())}</D:href>`;
      if (want.mode === "propname") {
        const names = [...ALLPROP, ...QUOTA].filter((n) => !(r.st.isDirectory() && (n === "getcontentlength" || n === "getcontenttype")));
        out += `<D:propstat><D:prop>${names.map((n) => `<D:${n}/>`).join("")}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat>`;
      } else {
        const props = want.mode === "allprop" ? ALLPROP.map((local) => ({ ns: DAV, local })) : want.props;
        const found: string[] = [];
        const missing: string[] = [];
        for (const p of props) {
          const v = await live(p, r, quota);
          if (v === undefined) {
            if (want.mode === "prop") missing.push(propXml(p, null));
          } else {
            found.push(propXml(p, v));
          }
        }
        if (found.length) out += `<D:propstat><D:prop>${found.join("")}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat>`;
        if (missing.length) out += `<D:propstat><D:prop>${missing.join("")}</D:prop><D:status>${statusLine(404)}</D:status></D:propstat>`;
      }
      yield `${out}</D:response>`;
    }
    yield `</D:multistatus>`;
  }

  /** The resource and, at depth 1, its members — links out and broken links left out. */
  /**
   * The names to report beneath a collection, read and sorted (directories
   * first, as a person reads them) before the response starts, so a failure
   * here is a clean error rather than a half-sent 207.
   */
  const memberNames = async (abs: string, real: string): Promise<string[]> => {
    try {
      const dirents = await fsp.readdir(fsPath(real), { withFileTypes: true, encoding: "buffer" });
      return dirents
        .map((d) => ({ name: decodeName(d.name), dir: d.isDirectory() }))
        .filter((d) => !(abs === ws.path && d.name === STATE_DIR))
        .sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
        .map((d) => d.name);
    } catch (err) {
      throw fsError(err, abs);
    }
  };

  /**
   * The folder's own resource, then its members. A link that leads out of the
   * root is left out, and so is one that leads back to a folder on the way
   * here or above it (see {@link loopCheck}): shown as a folder, it would be
   * an endless tree to any client that walks the mount.
   */
  async function* members(abs: string, real: string, st: Stats, names: string[], path_: Set<string>): AsyncGenerator<Resource> {
    yield { abs, st, locks: locks.covering(abs) };
    const rootReal = await roots.realRoot(ws);
    for (const name of names) {
      const childReal = path.join(real, name);
      let cst: Stats;
      try {
        cst = await fsp.lstat(fsPath(childReal));
        if (cst.isSymbolicLink()) {
          const target = decodeName(await fsp.realpath(fsPath(childReal), { encoding: "buffer" }));
          if (!within(target, rootReal)) continue;
          if (path_.has(target) || within(real, target)) continue;
          cst = await fsp.stat(fsPath(target));
        }
      } catch {
        continue;
      }
      if (!cst.isFile() && !cst.isDirectory()) continue;
      const childAbs = path.join(abs, name);
      yield { abs: childAbs, st: cst, locks: locks.covering(childAbs) };
    }
  }

  /** Evaluate an `If` header against current locks and entity tags. */
  const ifHolds = async (req: FastifyRequest, abs: string): Promise<boolean> => {
    const header = req.headers.if;
    if (typeof header !== "string" || header.trim() === "") return true;
    const lists = parseIf(header);
    if (!lists) throw new FilesError(400, "malformed If header");
    for (const list of lists) {
      let target = abs;
      if (list.resource) {
        try {
          target = toAbs(new URL(list.resource, "http://dav.invalid").pathname);
        } catch {
          continue;
        }
      }
      let etag: string | null | undefined;
      let ok = true;
      for (const c of list.conditions) {
        let holds: boolean;
        if (c.kind === "token") {
          const l = locks.get(c.value);
          holds = !!l && (l.path === target || (l.depth === "infinity" && within(target, l.path)));
        } else {
          if (etag === undefined) {
            const r = await resource(target).catch(() => null);
            etag = r ? etagOf(r.st) : null;
          }
          holds = etag !== null && (c.value === etag || c.value === `W/${etag}`);
        }
        if (holds === c.not) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };

  /**
   * Answer 412 when the `If` header fails or 423 when a lock is in the way,
   * and say whether it did. A boolean, not the reply: a Fastify reply is
   * thenable, so awaiting one that was handed back resolves to nothing once it
   * is sent — and the caller would go on to do the write it just refused.
   */
  const refused = async (
    req: FastifyRequest,
    reply: FastifyReply,
    abs: string,
    paths: { path: string; subtree: boolean }[],
  ): Promise<boolean> => {
    if (!(await ifHolds(req, abs))) {
      reply.code(412).send();
      return true;
    }
    const header = typeof req.headers.if === "string" ? req.headers.if : undefined;
    const blocked = locks.blocked(paths, submittedTokens(header));
    if (blocked) {
      davError(reply, 423, `<D:lock-token-submitted><D:href>${href(blocked.path, false)}</D:href></D:lock-token-submitted>`);
      return true;
    }
    return false;
  };

  const parentOf = (abs: string): string => path.dirname(abs);

  const parentExists = async (fs: string): Promise<boolean> => {
    const st = await fsp.stat(fsPath(path.dirname(fs))).catch(() => null);
    return !!st?.isDirectory();
  };

  // --- methods ---------------------------------------------------------------

  const options = (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(200).headers({ dav: "1, 2", "ms-author-via": "DAV", allow: ALLOW, "content-length": "0" }).send();

  const get = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    if (loadedAsCode(req)) throw new FilesError(403, "a file cannot be loaded as a script or stylesheet", "not-code");
    const r = await resource(abs);
    if (!r) throw new FilesError(404, "not found");
    if (r.st.isDirectory()) return reply.code(405).header("allow", ALLOW).send();
    return sendFile(req, reply, r.real, path.basename(abs), r.st, false);
  };

  const propfind = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    const raw = String(req.headers.depth ?? "1").toLowerCase();
    if (raw === "infinity") return davError(reply, 403, "<D:propfind-finite-depth/>");
    const depth = raw === "0" ? "0" : "1";
    const body = parseBody(await readBody(req));
    let want: Want = { mode: "allprop" };
    if (body) {
      if (body.ns !== DAV || body.local !== "propfind") throw new FilesError(400, "expected a propfind element");
      const prop = child(body, "prop");
      if (child(body, "propname")) want = { mode: "propname" };
      else if (prop) want = { mode: "prop", props: prop.children.map((c) => ({ ns: c.ns, local: c.local })) };
    }
    const r = await resource(abs);
    if (!r) throw new FilesError(404, "not found");
    const names = depth === "1" && r.st.isDirectory() ? await memberNames(abs, r.real) : [];
    const visited = await loopCheck(abs);
    // Streamed: a directory of a hundred thousand entries is a long answer.
    return reply
      .code(207)
      .header("content-type", "application/xml; charset=utf-8")
      .send(Readable.from(multistatus(members(abs, r.real, r.st, names, visited), want)));
  };

  const proppatch = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    const body = parseBody(await readBody(req));
    if (!body || body.ns !== DAV || body.local !== "propertyupdate") throw new FilesError(400, "expected a propertyupdate element");
    const r = await resource(abs);
    if (!r) throw new FilesError(404, "not found");
    if (await refused(req, reply, abs, [{ path: abs, subtree: false }])) return reply;
    // Windows sends its timestamps this way after every copy; they are the
    // only properties with a meaning here. Everything else is refused, and
    // PROPPATCH is all or nothing, so one refusal fails the rest.
    const changes: { p: PropName; value: string | null; allowed: boolean }[] = [];
    for (const op of body.children) {
      if (op.ns !== DAV || (op.local !== "set" && op.local !== "remove")) continue;
      for (const prop of child(op, "prop")?.children ?? []) {
        const allowed = prop.ns === MS || (prop.ns === DAV && prop.local === "getlastmodified" && op.local === "set");
        changes.push({ p: { ns: prop.ns, local: prop.local }, value: op.local === "set" ? prop.text : null, allowed });
      }
    }
    const anyRefused = changes.some((c) => !c.allowed);
    if (!anyRefused) {
      for (const c of changes) {
        const mtime = c.value && (c.p.local === "Win32LastModifiedTime" || c.p.local === "getlastmodified") ? new Date(c.value) : null;
        if (mtime && !Number.isNaN(mtime.getTime())) await fsp.utimes(fsPath(r.real), r.st.atime, mtime);
      }
    }
    const groups = new Map<number, string[]>();
    for (const c of changes) {
      const code = !anyRefused ? 200 : c.allowed ? 424 : 403;
      groups.set(code, [...(groups.get(code) ?? []), propXml(c.p, null)]);
    }
    const stats = [...groups]
      .map(([code, props]) => `<D:propstat><D:prop>${props.join("")}</D:prop><D:status>${statusLine(code)}</D:status></D:propstat>`)
      .join("");
    return xml(reply, 207, `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${href(abs, r.st.isDirectory())}</D:href>${stats}</D:response></D:multistatus>`);
  };

  const put = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    if (req.headers["content-range"]) throw new FilesError(400, "partial PUT is not supported");
    const dest = await roots.creatable(abs);
    roots.assertMutable(dest);
    if (!(await parentExists(dest.fs))) throw new FilesError(409, "the parent collection does not exist");
    let target = dest.fs;
    const existing = await fsp.lstat(fsPath(dest.fs)).catch(() => null);
    if (existing?.isSymbolicLink()) {
      // Write through a link that stays inside, keeping the link itself.
      target = (await roots.target(abs)).real;
    }
    const st = existing ? await fsp.stat(fsPath(target)).catch(() => null) : null;
    if (st?.isDirectory()) return reply.code(405).header("allow", ALLOW).send();
    // A new member changes its parent's membership, which the parent's lock guards.
    const guarded = [{ path: abs, subtree: false }, ...(existing ? [] : [{ path: parentOf(abs), subtree: false }])];
    if (await refused(req, reply, abs, guarded)) return reply;

    const dir = path.join(roots.stateDir(dest.root), "uploads");
    await fsp.mkdir(dir, { recursive: true });
    const tmp = scratchName(dir, "dav");
    try {
      const body = req.body as Readable | undefined;
      if (body) await pipeline(body, createWriteStream(tmp));
      else await fsp.writeFile(tmp, "");
      // A PUT over a file is a save: it replaces in place (no trash) and the
      // file keeps its mode, as it would saved from an editor.
      if (st?.isFile()) await fsp.chmod(tmp, st.mode & 0o7777);
      await fsp.rename(tmp, fsPath(target));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw fsError(err, abs);
    }
    return reply.code(existing ? 204 : 201).send();
  };

  const del = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    const ref = await roots.entry(abs);
    roots.assertMutable(ref);
    const guarded = [
      { path: abs, subtree: true },
      { path: parentOf(abs), subtree: false },
    ];
    if (await refused(req, reply, abs, guarded)) return reply;
    // Only a regular file by one of those exact names is litter; a folder
    // that happens to be called `._x` is the user's and goes to the trash.
    const litter = OS_JUNK.test(path.basename(abs)) && (await fsp.lstat(fsPath(ref.fs))).isFile();
    if (litter) await fsp.unlink(fsPath(ref.fs));
    else await files.trash.put(ref.root, ref.abs, ref.fs);
    locks.dropBeneath(abs);
    return reply.code(204).send();
  };

  const mkcol = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    if ((await readBody(req)).length > 0) return reply.code(415).send();
    const dest = await roots.creatable(abs);
    roots.assertMutable(dest);
    if (!(await parentExists(dest.fs))) throw new FilesError(409, "the parent collection does not exist");
    if (await fsp.lstat(fsPath(dest.fs)).catch(() => null)) return reply.code(405).header("allow", ALLOW).send();
    const guarded = [
      { path: abs, subtree: false },
      { path: parentOf(abs), subtree: false },
    ];
    if (await refused(req, reply, abs, guarded)) return reply;
    try {
      await fsp.mkdir(fsPath(dest.fs));
    } catch (err) {
      throw fsError(err, abs);
    }
    return reply.code(201).send();
  };

  const copyOrMove = async (req: FastifyRequest, reply: FastifyReply, abs: string, move: boolean) => {
    const header = req.headers.destination;
    if (typeof header !== "string" || header === "") throw new FilesError(400, "Destination header required");
    let dest_: URL;
    try {
      dest_ = new URL(header, "http://dav.invalid");
    } catch {
      throw new FilesError(400, "bad Destination header");
    }
    // An absolute Destination naming another host is a copy to another
    // server, which this one cannot do (RFC 4918 §9.8.4: 502).
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(header);
    const host = String(req.headers.host ?? "").toLowerCase();
    const destPath = dest_.pathname;
    if ((absolute && dest_.host.toLowerCase() !== host) || (destPath !== DAV_PREFIX && !destPath.startsWith(`${DAV_PREFIX}/`))) {
      throw new FilesError(502, "the destination is not on this server");
    }
    const destAbs = toAbs(destPath);
    const depth = String(req.headers.depth ?? "infinity").toLowerCase();
    if (move && depth !== "infinity") throw new FilesError(400, "MOVE is always depth infinity");
    if (!move && depth !== "0" && depth !== "infinity") throw new FilesError(400, "COPY takes depth 0 or infinity");
    const overwrite = String(req.headers.overwrite ?? "T").toUpperCase() !== "F";

    const src = await roots.entry(abs);
    if (move) roots.assertMutable(src);
    await roots.assertMovable(src);
    if (destAbs === src.abs) return reply.code(403).send();
    const dest = await roots.creatable(destAbs);
    roots.assertMutable(dest);
    if (!(await parentExists(dest.fs))) throw new FilesError(409, "the destination's parent does not exist");
    const srcSt = await fsp.lstat(fsPath(src.fs));
    if (srcSt.isDirectory() && within(dest.fs, src.fs)) throw new FilesError(409, "cannot put a collection inside itself");

    const guarded = [
      ...(move ? [{ path: abs, subtree: true }, { path: parentOf(abs), subtree: false }] : []),
      { path: destAbs, subtree: true },
      { path: parentOf(destAbs), subtree: false },
    ];
    if (await refused(req, reply, abs, guarded)) return reply;

    const existed = !!(await fsp.lstat(fsPath(dest.fs)).catch(() => null));
    if (existed) {
      if (!overwrite) return reply.code(412).send();
      await files.trash.put(dest.root, dest.abs, dest.fs);
    }
    const scratch = path.join(roots.stateDir(dest.root), "uploads");
    try {
      if (move) {
        if (src.root.id === dest.root.id) await noClobberRename(src.fs, dest.fs);
        else await moveTree(src.fs, dest.fs, scratch);
        locks.dropBeneath(abs);
      } else if (srcSt.isDirectory() && depth === "0") {
        await fsp.mkdir(fsPath(dest.fs));
      } else {
        await fsp.mkdir(scratch, { recursive: true });
        const tmp = scratchName(scratch, "copy");
        try {
          await copyTree(src.fs, tmp);
          await noClobberRename(tmp, dest.fs);
        } catch (err) {
          await removeTree(tmp).catch(() => {});
          throw err;
        }
      }
    } catch (err) {
      throw fsError(err, destAbs);
    }
    return reply.code(existed ? 204 : 201).send();
  };

  const lock = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    const timeoutS = parseTimeout(typeof req.headers.timeout === "string" ? req.headers.timeout : undefined);
    const body = parseBody(await readBody(req));
    if (!body) {
      // A refresh: the lock is named in the If header.
      const header = typeof req.headers.if === "string" ? req.headers.if : undefined;
      for (const t of submittedTokens(header)) {
        const l = locks.get(t);
        if (l && (l.path === abs || (l.depth === "infinity" && within(abs, l.path)))) {
          locks.refresh(t, timeoutS);
          return xml(reply, 200, `<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLock(l)}</D:lockdiscovery></D:prop>`);
        }
      }
      return reply.code(412).send();
    }
    if (body.ns !== DAV || body.local !== "lockinfo") throw new FilesError(400, "expected a lockinfo element");
    const scopeEl = child(body, "lockscope");
    const scope = scopeEl && child(scopeEl, "shared") ? "shared" : "exclusive";
    const typeEl = child(body, "locktype");
    if (typeEl && !child(typeEl, "write")) throw new FilesError(422, "only write locks exist");
    const ownerEl = child(body, "owner");
    const owner = ownerEl ? ownerEl.children.map(serialize).join("") + escapeXml(ownerEl.children.length ? "" : ownerEl.text) : "";
    const depthRaw = String(req.headers.depth ?? "infinity").toLowerCase();
    if (depthRaw !== "0" && depthRaw !== "infinity") throw new FilesError(400, "LOCK takes depth 0 or infinity");

    const loc = locate(abs);
    const existing = await resource(abs);
    if (!existing) {
      // Locking an unmapped URL creates an empty resource (RFC 4918 §7.3).
      const dest = await roots.creatable(abs);
      roots.assertMutable(dest);
      if (!(await parentExists(dest.fs))) throw new FilesError(409, "the parent collection does not exist");
    } else if (loc.abs === loc.root.path && depthRaw === "infinity") {
      // Locking the whole workspace would stall every other client.
      throw new FilesError(403, "the root cannot be locked as a whole");
    }
    const got = locks.acquire(abs, { depth: depthRaw === "0" ? "0" : "infinity", scope, owner, timeoutS });
    if ("conflicts" in got) {
      return davError(reply, 423, `<D:no-conflicting-lock>${got.conflicts.map((l) => `<D:href>${href(l.path, false)}</D:href>`).join("")}</D:no-conflicting-lock>`);
    }
    if ("full" in got) throw new FilesError(503, "too many locks are held; try again later", "too-many-locks");
    if (!existing) {
      const dest = await roots.creatable(abs);
      try {
        await fsp.writeFile(fsPath(dest.fs), "", { flag: "wx" });
      } catch (err) {
        locks.release(got.lock.token);
        throw fsError(err, abs);
      }
    }
    reply.header("lock-token", `<${got.lock.token}>`);
    return xml(reply, existing ? 200 : 201, `<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLock(got.lock)}</D:lockdiscovery></D:prop>`);
  };

  const unlock = async (req: FastifyRequest, reply: FastifyReply, abs: string) => {
    const header = req.headers["lock-token"];
    const token = typeof header === "string" ? header.trim().replace(/^<|>$/g, "") : "";
    if (!token) throw new FilesError(400, "Lock-Token header required");
    const l = locks.get(token);
    if (!l || !(l.path === abs || (l.depth === "infinity" && within(abs, l.path)))) {
      return davError(reply, 409, "<D:lock-token-matches-request-uri/>");
    }
    locks.release(token);
    return reply.code(204).send();
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const abs = toAbs(rawPathOf(req));
      // A path that goes round a symlink loop names nothing, for every method.
      if (req.method !== "OPTIONS") await loopCheck(abs);
      switch (req.method) {
        case "OPTIONS":
          return options(req, reply);
        case "GET":
        case "HEAD":
          return await get(req, reply, abs);
        case "PROPFIND":
          return await propfind(req, reply, abs);
        case "PROPPATCH":
          return await proppatch(req, reply, abs);
        case "PUT":
          return await put(req, reply, abs);
        case "DELETE":
          return await del(req, reply, abs);
        case "MKCOL":
          return await mkcol(req, reply, abs);
        case "COPY":
          return await copyOrMove(req, reply, abs, false);
        case "MOVE":
          return await copyOrMove(req, reply, abs, true);
        case "LOCK":
          return await lock(req, reply, abs);
        case "UNLOCK":
          return await unlock(req, reply, abs);
        default:
          return reply.code(405).header("allow", ALLOW).send();
      }
    } catch (err) {
      return sendError(reply, err);
    }
  };

  void app.register(async (scope) => {
    // Bodies are XML to parse ourselves or file content to stream to disk;
    // no parser may consume them first.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    scope.addHook("onSend", closeIfBodyUnread);
    const methods = ["OPTIONS", "GET", "HEAD", "PUT", "DELETE", ...DAV_METHODS];
    scope.route({ method: methods, url: DAV_PREFIX, handler });
    scope.route({ method: methods, url: `${DAV_PREFIX}/*`, handler });
  });
}
