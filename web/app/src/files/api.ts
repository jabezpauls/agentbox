import { encodePathParam, type FileEntry, type FileListing, type TrashItem, type UploadSession } from "@workbench/shared";
import { http } from "../api/http.ts";

/**
 * The bridge's files API (`/api/files/*`, see docs/workbench.md). Paths are
 * absolute and go back exactly as they came: through {@link encodePathParam}
 * in a query string, unchanged in a JSON body.
 */

const q = (path: string) => encodePathParam(path);

export interface TrashResult {
  trashed: TrashItem[];
  missing: string[];
}

export const filesApi = {
  list(path: string, opts: { hidden?: boolean; offset?: number; limit?: number } = {}, signal?: AbortSignal): Promise<FileListing> {
    const params = [`path=${q(path)}`];
    if (opts.hidden) params.push("hidden=1");
    if (opts.offset) params.push(`offset=${opts.offset}`);
    if (opts.limit) params.push(`limit=${opts.limit}`);
    return http.get<FileListing>(`/api/files/list?${params.join("&")}`, signal);
  },
  stat: (path: string) => http.get<FileEntry>(`/api/files/stat?path=${q(path)}`),
  search: (query: string, opts: { path?: string; limit?: number } = {}, signal?: AbortSignal) =>
    http.get<FileEntry[]>(
      `/api/files/search?q=${encodeURIComponent(query)}${opts.path ? `&path=${q(opts.path)}` : ""}&limit=${opts.limit ?? 30}`,
      signal,
    ),
  write: (path: string, content: string, overwrite = false) => http.post<FileEntry>("/api/files/write", { path, content, overwrite }),
  mkdir: (path: string) => http.post<FileEntry>("/api/files/mkdir", { path }),
  move: (from: string, to: string, overwrite = false) => http.post<FileEntry>("/api/files/move", { from, to, overwrite }),
  copy: (from: string, to: string, overwrite = false) => http.post<FileEntry>("/api/files/copy", { from, to, overwrite }),
  trash: (paths: string[]) => http.post<TrashResult>("/api/files/trash", { paths }),
  trashList: () => http.get<TrashItem[]>("/api/files/trash"),
  restore: (id: string, to?: string) => http.post<FileEntry>(`/api/files/trash/${encodeURIComponent(id)}/restore`, to ? { to } : {}),
  removeFromTrash: (id: string) => http.del<void>(`/api/files/trash/${encodeURIComponent(id)}`),
  emptyTrash: () => http.del<{ removed: number }>("/api/files/trash"),
  uploadStart: (path: string, size: number, overwrite: boolean) =>
    http.post<UploadSession & { uploadId: string }>("/api/files/uploads", { path, size, overwrite }),
  uploadStatus: (id: string) => http.get<UploadSession>(`/api/files/uploads/${id}`),
  uploadFinish: (id: string) => http.post<FileEntry>(`/api/files/uploads/${id}/finish`),
  uploadCancel: (id: string) => http.del<void>(`/api/files/uploads/${id}`),
};

/** A file's bytes; `inline` asks to show it (pictures, PDF, text) rather than download it. */
export function rawUrl(path: string, inline = false): string {
  return `/api/files/raw?path=${q(path)}${inline ? "&inline=1" : ""}`;
}

/** A zip of one or more paths, streamed. */
export function zipUrl(paths: string[], name?: string): string {
  const parts = paths.map((p) => `path=${q(p)}`);
  if (name) parts.push(`name=${encodeURIComponent(name)}`);
  return `/api/files/zip?${parts.join("&")}`;
}

/** Start a download without leaving the page. */
export function download(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
