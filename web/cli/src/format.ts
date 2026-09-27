/** Output helpers: sizes, times and tables as people read them. */

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** `2026-09-28 14:03` in local time, or `Sep 28 2025` when it is not this year. */
export function formatTime(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const pad = (x: number): string => String(x).padStart(2, "0");
  if (d.getFullYear() !== new Date(now).getFullYear()) {
    return `${d.toLocaleString("en", { month: "short" })} ${pad(d.getDate())} ${d.getFullYear()}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "3 minutes ago", "in 2 hours". */
export function formatAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms) return "never";
  const s = Math.round((now - ms) / 1000);
  const abs = Math.abs(s);
  const [n, unit] =
    abs < 60 ? [abs, "second"] : abs < 3600 ? [Math.round(abs / 60), "minute"] : abs < 86400 ? [Math.round(abs / 3600), "hour"] : [Math.round(abs / 86400), "day"];
  if (abs < 5) return "just now";
  const phrase = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return s >= 0 ? `${phrase} ago` : `in ${phrase}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Display width, near enough: control characters take none, everything else one. */
function width(s: string): number {
  return [...s.replace(/[\u0000-\u001f\u007f]/g, "")].length;
}

/** Characters a terminal would act on, made visible: a file name is data, not a command. */
export function safeText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * A plain table: a header row and columns padded to fit, the last column
 * left ragged. `align` marks right-aligned columns (sizes).
 */
export function table(header: string[], rows: string[][], align: Array<"left" | "right"> = []): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ""))));
  const line = (r: string[]): string =>
    r
      .map((cell, i) => {
        const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - width(cell)));
        if (i === r.length - 1 && align[i] !== "right") return cell;
        return align[i] === "right" ? pad + cell : cell + pad;
      })
      .join("  ")
      .trimEnd();
  return `${all.map(line).join("\n")}\n`;
}
