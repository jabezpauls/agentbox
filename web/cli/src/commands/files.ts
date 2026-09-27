import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bool, parseSize, type OptionSpec } from "../args.js";
import type { Context } from "../context.js";
import { ApiError, CliError, EXIT, UsageError } from "../errors.js";
import { FilesApi, joinRemote, MAX_CHUNK, remoteBase } from "../files-api.js";
import { formatBytes, formatTime, safeText, table } from "../format.js";
import { Progress } from "../progress.js";
import type { FileEntry } from "../remote.js";
import { downloadFile, ResumeStore, streamTo, uploadFile } from "../transfer.js";
import { command, type Command } from "./types.js";

/** The most `edit` saves with a plain write; larger files go up as an upload. */
const MAX_WRITE = 1024 * 1024;

const RECURSIVE: OptionSpec = { name: "recursive", short: "r", type: "boolean", description: "folders and everything in them" };
const FORCE: OptionSpec = {
  name: "force",
  short: "f",
  type: "boolean",
  description: "replace what is already there (the box keeps the old one in its trash)",
};

async function filesApi(ctx: Context): Promise<FilesApi> {
  const { client } = await ctx.connect();
  return new FilesApi(client);
}

function isDir(e: FileEntry | null): boolean {
  return !!e && (e.type === "dir" || (e.type === "symlink" && e.targetType === "dir"));
}

function isFile(e: FileEntry | null): boolean {
  return !!e && (e.type === "file" || (e.type === "symlink" && e.targetType === "file"));
}

async function mustStat(files: FilesApi, p: string): Promise<FileEntry> {
  const e = await files.stat(p);
  if (!e) throw new CliError(`${p}: no such file or folder on the box`, EXIT.NOT_FOUND);
  return e;
}

/** An existing-destination refusal, with how to get past it. */
function withForceHint(err: unknown): unknown {
  if (err instanceof ApiError && err.status === 409 && err.code === "exists") {
    return new CliError(`${err.message.replace(/^[^:]*: /, "")}; add --force to replace it (the old one goes to the box's trash)`);
  }
  return err;
}

/**
 * A name from the box as a local file name. Linux allows almost anything;
 * Windows does not, and a name must never become a path on either.
 */
export function localName(name: string, platform: NodeJS.Platform = process.platform): string {
  let n = name.replace(/\//g, "_");
  if (platform === "win32") n = n.replace(/[<>:"\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "_");
  if (n === "." || n === ".." || n === "") n = n.replace(/\./g, "_") || "_";
  return n;
}

function gitMark(g: string | null | undefined): string {
  switch (g) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    case "ignored":
      return "!";
    case "conflicted":
      return "U";
    default:
      return "";
  }
}

function displayName(e: FileEntry): string {
  const name = safeText(e.name);
  if (e.type === "dir") return `${name}/`;
  if (e.type === "symlink") return `${name} -> ${safeText(e.target ?? "?")}`;
  return name;
}

function entryTable(entries: FileEntry[], now: number): string {
  const withGit = entries.some((e) => gitMark(e.git) !== "");
  const header = withGit ? ["SIZE", "MODIFIED", "GIT", "NAME"] : ["SIZE", "MODIFIED", "NAME"];
  const rows = entries.map((e) => {
    const size = e.type === "dir" ? "-" : formatBytes(e.size);
    const cells = [size, formatTime(e.mtime, now)];
    if (withGit) cells.push(gitMark(e.git));
    cells.push(displayName(e));
    return cells;
  });
  return table(header, rows, ["right"]);
}

const ls = command({
  path: ["files", "ls"],
  summary: "list a folder on the box",
  usage: "[path]",
  operands: { min: 0, max: 1 },
  json: true,
  options: [{ name: "all", short: "a", type: "boolean", description: "include hidden files" }],
  details: "Paths are the box's: absolute, relative to /workspace, or '~/…' for home (quote it, or your shell expands it).",
  async run(ctx, p) {
    const files = await filesApi(ctx);
    const target = p.operands[0] ?? "";
    let listing;
    try {
      listing = await files.listAll(target, bool(p.options, "all"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "not-a-directory") {
        const e = await mustStat(files, target);
        if (ctx.json) ctx.printJson(e);
        else ctx.out(entryTable([e], ctx.now()));
        return;
      }
      throw err;
    }
    if (ctx.json) {
      ctx.printJson({ path: listing.path, root: listing.root, total: listing.total, entries: listing.entries });
      return;
    }
    if (listing.entries.length === 0) {
      ctx.err(`${listing.path} is empty\n`);
      return;
    }
    ctx.out(entryTable(listing.entries, ctx.now()));
  },
});

const stat = command({
  path: ["files", "stat"],
  summary: "details of one file or folder",
  usage: "<path>",
  operands: { min: 1, max: 1 },
  json: true,
  async run(ctx, p) {
    const files = await filesApi(ctx);
    const e = await mustStat(files, p.operands[0] as string);
    if (ctx.json) {
      ctx.printJson(e);
      return;
    }
    ctx.out(`${safeText(e.path)}\n  type      ${e.type}${e.type === "symlink" ? ` -> ${safeText(e.target ?? "?")} (${e.targetType ?? "outside or broken"})` : ""}\n`);
    ctx.out(`  size      ${e.type === "dir" ? "-" : `${formatBytes(e.size)} (${e.size} bytes)`}\n  modified  ${new Date(e.mtime).toISOString()}\n`);
    if (e.git) ctx.out(`  git       ${e.git}\n`);
  },
});

/** Downloads, with a progress line each, relative to where they were asked for. */
class Getter {
  constructor(
    private readonly ctx: Context,
    private readonly files: FilesApi,
  ) {}

  async one(remote: string, local: string): Promise<void> {
    const progress = new Progress(this.ctx.io.stderr, local, null);
    try {
      await downloadFile({
        api: this.files,
        remote,
        local,
        onProgress: (n) => progress.update(n),
        signal: this.ctx.abort.signal,
      });
    } catch (err) {
      progress.abandon();
      throw err;
    }
    progress.finish();
  }

  async tree(dir: FileEntry, local: string): Promise<void> {
    await fs.promises.mkdir(local, { recursive: true });
    const listing = await this.files.listAll(dir.path, true);
    for (const e of listing.entries) {
      const dest = path.join(local, localName(e.name, this.ctx.platform));
      if (e.type === "dir") await this.tree(e, dest);
      else if (isFile(e)) await this.one(e.path, dest);
      else if (isDir(e)) this.ctx.warn(`skipped ${safeText(e.path)}: a link to a folder (get the folder itself)`);
      else this.ctx.warn(`skipped ${safeText(e.path)}: not a file or folder`);
    }
  }
}

function localIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const get = command({
  path: ["files", "get"],
  summary: "download files or folders from the box",
  usage: "<remote>… [local]",
  operands: { min: 1, max: Infinity },
  options: [RECURSIVE],
  details: "With one path, downloads into the current folder. The last argument is where to put them\n(a folder, or '-' for stdout). Existing local files are replaced.",
  async run(ctx, p) {
    const files = await filesApi(ctx);
    const ops = p.operands;
    const remotes = ops.length === 1 ? ops : ops.slice(0, -1);
    const local = ops.length === 1 ? "." : (ops[ops.length - 1] as string);
    if (local === "-") {
      if (remotes.length !== 1) throw new UsageError("'-' takes exactly one file");
      const e = await mustStat(files, remotes[0] as string);
      if (!isFile(e)) throw new CliError(`${e.path} is not a file`);
      await streamTo(files, e.path, ctx.io.stdout, ctx.abort.signal);
      return;
    }
    const intoDir = localIsDir(local);
    if (remotes.length > 1 && !intoDir) throw new CliError(`${local} is not a folder here; getting several things needs one`);
    const getter = new Getter(ctx, files);
    for (const r of remotes) {
      const e = await mustStat(files, r);
      const dest = intoDir ? path.join(local, localName(e.name, ctx.platform)) : local;
      if (isDir(e)) {
        if (!bool(p.options, "recursive")) throw new CliError(`${e.path} is a folder; add -r to get it and everything in it`);
        await getter.tree(e, dest);
      } else if (isFile(e)) {
        await getter.one(e.path, dest);
      } else {
        throw new CliError(`${e.path} is not a file or folder`);
      }
    }
  },
});

const put = command({
  path: ["files", "put"],
  summary: "upload files or folders to the box",
  usage: "<local>… [remote]",
  operands: { min: 1, max: Infinity },
  options: [
    RECURSIVE,
    FORCE,
    { name: "chunk-size", type: "string", value: "size", description: `bytes per request, up to ${MAX_CHUNK / 1024 / 1024}M (default); lower it for a proxy with a smaller limit` },
  ],
  details:
    "With one path, uploads into /workspace. The last argument is where: an existing folder, a new name,\n" +
    "or a path ending in '/' for a folder to create. Large files go up in chunks; if an upload is cut off,\n" +
    "run the same command again and it resumes where the box left off.",
  async run(ctx, p) {
    const files = await filesApi(ctx);
    const ops = p.operands;
    const locals = ops.length === 1 ? ops : ops.slice(0, -1);
    const remote = ops.length === 1 ? "" : (ops[ops.length - 1] as string);
    const force = bool(p.options, "force");
    const chunkRaw = typeof p.options["chunk-size"] === "string" ? parseSize(p.options["chunk-size"]) : MAX_CHUNK;
    if (chunkRaw < 1024 || chunkRaw > MAX_CHUNK) throw new UsageError(`--chunk-size must be from 1K to ${MAX_CHUNK / 1024 / 1024}M`);
    const resume = new ResumeStore(ctx.config.dir);

    let target = await files.stat(remote);
    if (!target && remote.endsWith("/")) target = await files.mkdir(remote);
    const intoDir = isDir(target);
    if (locals.length > 1 && !intoDir) throw new CliError(`${remote} is not a folder on the box; putting several things needs one`);

    const putOne = async (file: string, dest: string): Promise<void> => {
      const size = (await fs.promises.stat(file)).size;
      const bar = new Progress(ctx.io.stderr, file, size);
      try {
        await uploadFile({
          api: files,
          file,
          remote: dest,
          overwrite: force,
          chunkSize: chunkRaw,
          resume,
          signal: ctx.abort.signal,
          onProgress: (sent) => bar.update(sent),
          onResume: (received, total) => ctx.err(`${file}: resuming at ${formatBytes(received)} of ${formatBytes(total)}\n`),
        });
      } catch (err) {
        bar.abandon();
        if (err instanceof CliError && err.exitCode === EXIT.INTERRUPTED) {
          throw new CliError(`interrupted; run the same command again to resume ${file}`, EXIT.INTERRUPTED);
        }
        throw withForceHint(err);
      }
      bar.finish();
    };

    const putTree = async (dir: string, dest: string): Promise<void> => {
      await files.mkdir(dest);
      const names = (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const d of names) {
        const local = path.join(dir, d.name);
        const there = joinRemote(dest, d.name);
        if (d.isDirectory()) await putTree(local, there);
        else if (d.isFile()) await putOne(local, there);
        else if (d.isSymbolicLink()) {
          const st = await fs.promises.stat(local).catch(() => null);
          if (st?.isFile()) await putOne(local, there);
          else ctx.warn(`skipped ${local}: a link to ${st?.isDirectory() ? "a folder (put the folder itself)" : "nothing"}`);
        } else ctx.warn(`skipped ${local}: not a file or folder`);
      }
    };

    for (const local of locals) {
      const st = await fs.promises.stat(local).catch(() => null);
      if (!st) throw new CliError(`${local}: no such file or folder here`, EXIT.NOT_FOUND);
      const dest = intoDir && target ? joinRemote(target.path, path.basename(path.resolve(local))) : remote;
      if (st.isDirectory()) {
        if (!bool(p.options, "recursive")) throw new CliError(`${local} is a folder; add -r to put it and everything in it`);
        await putTree(local, dest);
      } else if (st.isFile()) {
        await putOne(local, dest);
      } else {
        throw new CliError(`${local} is not a file or folder`);
      }
    }
  },
});

const rm = command({
  path: ["files", "rm"],
  summary: "move files or folders to the box's trash",
  usage: "<path>…",
  operands: { min: 1, max: Infinity },
  options: [RECURSIVE, { name: "force", short: "f", type: "boolean", description: "say nothing about paths that are not there" }],
  details: "Nothing is deleted outright: restore from Files → Trash in the app.",
  async run(ctx, p) {
    const files = await filesApi(ctx);
    const paths: string[] = [];
    for (const target of p.operands) {
      const e = await files.stat(target);
      if (!e) {
        if (bool(p.options, "force")) continue;
        throw new CliError(`${target}: no such file or folder on the box`, EXIT.NOT_FOUND);
      }
      if (e.type === "dir" && !bool(p.options, "recursive")) throw new CliError(`${e.path} is a folder; add -r to trash it and everything in it`);
      paths.push(e.path);
    }
    if (paths.length === 0) return;
    const result = await files.trash(paths);
    for (const t of result.trashed) ctx.err(`trashed ${safeText(t.originalPath)}\n`);
  },
});

function moveOrCopy(kind: "mv" | "cp"): Command {
  const verb = kind === "mv" ? "move" : "copy";
  return command({
    path: ["files", kind],
    summary: kind === "mv" ? "move or rename on the box" : "copy on the box",
    usage: "<from>… <to>",
    operands: { min: 2, max: Infinity },
    options: kind === "cp" ? [RECURSIVE, FORCE] : [FORCE],
    details: `Into <to> when it is an existing folder; otherwise <to> is the new name.`,
    async run(ctx, p) {
      const files = await filesApi(ctx);
      const sources = p.operands.slice(0, -1);
      const to = p.operands[p.operands.length - 1] as string;
      const toEntry = await files.stat(to);
      const intoDir = isDir(toEntry);
      if (sources.length > 1 && !intoDir) throw new CliError(`${to} is not a folder on the box; ${verb}ing several things needs one`);
      for (const src of sources) {
        const e = await mustStat(files, src);
        if (kind === "cp" && e.type === "dir" && !bool(p.options, "recursive")) {
          throw new CliError(`${e.path} is a folder; add -r to copy it and everything in it`);
        }
        const dest = intoDir && toEntry ? joinRemote(toEntry.path, remoteBase(e.path)) : to;
        try {
          const done = kind === "mv" ? await files.move(e.path, dest, bool(p.options, "force")) : await files.copy(e.path, dest, bool(p.options, "force"));
          ctx.err(`${kind === "mv" ? "moved" : "copied"} ${safeText(e.path)} → ${safeText(done.path)}\n`);
        } catch (err) {
          throw withForceHint(err);
        }
      }
    },
  });
}

const mkdir = command({
  path: ["files", "mkdir"],
  summary: "make folders on the box (and any missing parents)",
  usage: "<path>…",
  operands: { min: 1, max: Infinity },
  options: [{ name: "parents", short: "p", type: "boolean", description: "accepted for habit's sake: parents are always made" }],
  async run(ctx, p) {
    const files = await filesApi(ctx);
    for (const target of p.operands) await files.mkdir(target);
  },
});

const cat = command({
  path: ["files", "cat"],
  summary: "print files from the box",
  usage: "<path>…",
  operands: { min: 1, max: Infinity },
  async run(ctx, p) {
    const files = await filesApi(ctx);
    for (const target of p.operands) await streamTo(files, target, ctx.io.stdout, ctx.abort.signal);
  },
});

/** Run the person's editor on `file` and wait for it; resolves with its exit code. */
export function runEditor(editor: string, file: string, platform: NodeJS.Platform = process.platform): Promise<number> {
  return new Promise((resolve, reject) => {
    // $EDITOR may carry arguments ("code --wait"), so it goes through a shell,
    // with the file passed as a separate, quoted argument.
    const child =
      platform === "win32"
        ? spawn(`${editor} "${file}"`, { stdio: "inherit", shell: true })
        : spawn("/bin/sh", ["-c", `${editor} "$@"`, "sh", file], { stdio: "inherit" });
    child.once("error", (err) => reject(new CliError(`could not start the editor (${editor}): ${err.message}`)));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

const edit = command({
  path: ["files", "edit"],
  summary: "edit a file on the box in $EDITOR",
  usage: "<path>",
  operands: { min: 1, max: 1 },
  options: [{ name: "force", short: "f", type: "boolean", description: "save even if the file changed on the box meanwhile" }],
  details:
    "Downloads the file (or starts a new one), opens $VISUAL or $EDITOR on it, and saves it back when the\n" +
    "editor exits with changes. If the file changed on the box meanwhile, nothing is overwritten unless --force.",
  async run(ctx, p) {
    const files = await filesApi(ctx);
    const target = p.operands[0] as string;
    const before = await files.stat(target);
    if (before && !isFile(before)) throw new CliError(`${before.path} is not a file`);
    const remotePath = before?.path ?? target;
    let original = Buffer.alloc(0);
    if (before) {
      const res = await files.raw(before.path, ctx.abort.signal);
      const chunks: Buffer[] = [];
      for await (const c of res.stream) chunks.push(c as Buffer);
      original = Buffer.concat(chunks);
    }

    // Private to this user (mkdtemp makes 0700), named like the original so
    // the editor picks the right syntax.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-edit-"));
    const file = path.join(dir, localName(remoteBase(remotePath) || "file", ctx.platform));
    fs.writeFileSync(file, original, { mode: 0o600 });
    const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });

    const editor = ctx.env.VISUAL || ctx.env.EDITOR || (ctx.platform === "win32" ? "notepad" : "vi");
    const code = await runEditor(editor, file, ctx.platform);
    if (code !== 0) {
      cleanup();
      throw new CliError(`the editor exited with code ${code}; nothing was saved`);
    }
    const edited = fs.readFileSync(file);
    if (before && edited.equals(original)) {
      cleanup();
      ctx.err("No changes.\n");
      return;
    }
    if (!before && edited.length === 0) {
      cleanup();
      ctx.err("Nothing written; no file made.\n");
      return;
    }
    if (before && !bool(p.options, "force")) {
      const now = await files.stat(before.path);
      if (now && (now.mtime !== before.mtime || now.size !== before.size)) {
        throw new CliError(
          `${before.path} changed on the box while you were editing. Your version is kept in ${file}; ` +
            `to save it over theirs: agentbox files put --force '${file}' '${before.path}'`,
        );
      }
    }
    try {
      if (edited.length <= MAX_WRITE && isUtf8(edited)) {
        await files.write(remotePath, edited.toString("utf8"), before !== null);
      } else {
        // Too big or not text for a plain write: an upload (which keeps the
        // replaced version in the box's trash).
        await uploadFile({ api: files, file, remote: remotePath, overwrite: before !== null, signal: ctx.abort.signal });
      }
    } catch (err) {
      throw new CliError(`${(err as Error).message}. Your version is kept in ${file}.`, err instanceof CliError ? err.exitCode : EXIT.FAILURE);
    }
    cleanup();
    ctx.err(`Saved ${remotePath}.\n`);
  },
});

export const FILES_COMMANDS: Command[] = [ls, stat, get, put, rm, moveOrCopy("mv"), moveOrCopy("cp"), mkdir, cat, edit];
