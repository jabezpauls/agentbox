import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  Folder,
  FolderSymlink,
  Link2Off,
  type LucideIcon,
} from "lucide-react";
import type { FileEntry, GitFileStatus } from "@workbench/shared";
import { extOf } from "../../files/preview.ts";

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "sh", "bash", "zsh", "fish", "html", "htm", "css", "scss", "vue", "svelte", "astro", "sql", "yml", "yaml",
  "toml", "xml", "lua", "swift", "dart", "ex", "exs", "zig", "nix", "dockerfile", "ini", "conf", "env",
]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tiff"]);
const ARCHIVE = new Set(["zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar"]);
const TEXT = new Set(["md", "markdown", "txt", "rst", "log", "csv", "tsv"]);

export function isDirLike(e: Pick<FileEntry, "type" | "targetType">): boolean {
  return e.type === "dir" || (e.type === "symlink" && e.targetType === "dir");
}

export function iconFor(e: FileEntry): LucideIcon {
  if (e.type === "dir") return Folder;
  if (e.type === "symlink") return e.targetType === "dir" ? FolderSymlink : e.targetType ? iconFor({ ...e, type: e.targetType }) : Link2Off;
  const ext = extOf(e.name);
  if (IMAGE.has(ext)) return FileImage;
  if (ARCHIVE.has(ext)) return FileArchive;
  if (CODE.has(ext) || e.name === "Dockerfile" || e.name === "Makefile") return FileCode2;
  if (ext === "pdf") return FileType2;
  if (TEXT.has(ext)) return FileText;
  return File;
}

const GIT: Record<GitFileStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  untracked: { letter: "U", label: "Untracked" },
  ignored: { letter: "I", label: "Ignored by git" },
  conflicted: { letter: "C", label: "Conflicted" },
};

/** A git status mark: a letter in its tone, with the word as its name. */
export function GitMark({ status }: { status: GitFileStatus }) {
  if (status === "ignored") return null;
  const g = GIT[status];
  return (
    <span className={`git-mark is-${status}`} title={g.label} role="img" aria-label={g.label}>
      {g.letter}
    </span>
  );
}
