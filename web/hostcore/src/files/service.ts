import { ListingCache } from "./entries.js";
import { GitStatusCache } from "./git.js";
import { FileOps } from "./ops.js";
import { Roots } from "./roots.js";
import { Trash } from "./trash.js";
import { Uploads } from "./uploads.js";

export interface FilesOptions {
  workspaceRoot: string;
  homeRoot: string;
  /** Chunk cap override (tests). */
  maxChunk?: number;
  gitTtlMs?: number;
  /** The fd binary for name search; null forces the built-in walker. */
  fd?: string | null;
}

/**
 * Everything the files API, WebDAV and the project cards share: one set of
 * roots, one git cache, one trash. Constructing it touches nothing on disk;
 * {@link startMaintenance} is what sweeps abandoned uploads, and only the
 * real server calls it.
 */
export class FilesService {
  readonly roots: Roots;
  readonly git: GitStatusCache;
  readonly trash: Trash;
  readonly uploads: Uploads;
  readonly ops: FileOps;
  readonly fd: string | null | undefined;
  /** Sorted directory names, shared by the listing and WebDAV. */
  readonly listings = new ListingCache();

  constructor(opts: FilesOptions) {
    this.roots = new Roots(opts.workspaceRoot, opts.homeRoot);
    this.git = new GitStatusCache(opts.gitTtlMs === undefined ? {} : { ttlMs: opts.gitTtlMs });
    this.trash = new Trash(this.roots);
    this.uploads = new Uploads(this.roots, this.trash, opts.maxChunk === undefined ? {} : { maxChunk: opts.maxChunk });
    this.ops = new FileOps(this.roots, this.trash);
    this.fd = opts.fd;
  }

  /** Sweep abandoned uploads now and hourly; returns a stop. */
  startMaintenance(): () => void {
    return this.uploads.startSweeping();
  }
}
