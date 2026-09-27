/**
 * Numbers and times, the way the app says them: short, rounded to what a
 * person reads, in the one register everywhere ("4.2 GB", "5 min ago",
 * "up 3 days").
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Bytes in decimal units, as a file manager shows them: "0 B", "812 KB", "4.2 GB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.max(0, Math.round(n))} B`;
  let v = n;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v < 10 ? 1 : 0;
  return `${v.toFixed(digits).replace(/\.0$/, "")} ${UNITS[i]}`;
}

/** Bytes in binary units, for memory: "512 MiB", "7.6 GiB". */
export function formatMemory(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v < 10 && i > 0 ? 1 : 0;
  return `${v.toFixed(digits).replace(/\.0$/, "")} ${units[i]}`;
}

/** A share as a whole percent, never "NaN%": "37%", "<1%". */
export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return "—";
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/** How long ago, relative to `now`: "just now", "5 min ago", "3 h ago", "yesterday", "12 Sept". */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** A span of seconds, coarse: "45 s", "12 min", "3 h", "2 days". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** When something will stop, relative: "in 6 days", "in 3 h", "in 12 min". */
export function formatUntil(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return "in under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

/** CPUs busy, as a person counts them: "0.4 of 8 cores", "3 of 8 cores". */
export function formatCores(busy: number | null | undefined, of?: number | null): string {
  if (busy === null || busy === undefined || !Number.isFinite(busy)) return "—";
  const v = busy < 10 ? busy.toFixed(1).replace(/\.0$/, "") : String(Math.round(busy));
  const unit = of ? ` of ${of} core${of === 1 ? "" : "s"}` : ` core${v === "1" ? "" : "s"}`;
  return `${v}${unit}`;
}

/** Singular or plural: plural(2, "file") → "2 files". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

/** Good morning / afternoon / evening, for the hour of `now`. */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
