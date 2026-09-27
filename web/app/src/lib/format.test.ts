import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes, formatCores, formatDuration, formatMemory, formatPercent, formatUntil, greeting, plural } from "./format.ts";

describe("format", () => {
  it("says bytes the way a file manager does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(812_345)).toBe("812 KB");
    expect(formatBytes(4_200_000_000)).toBe("4.2 GB");
    expect(formatBytes(null)).toBe("—");
  });

  it("says memory in binary units", () => {
    expect(formatMemory(512 * 1024 * 1024)).toBe("512 MiB");
    expect(formatMemory(7.6 * 1024 ** 3)).toBe("7.6 GiB");
  });

  it("never prints NaN", () => {
    expect(formatPercent(1, 0)).toBe("—");
    expect(formatPercent(0.001, 1)).toBe("<1%");
    expect(formatPercent(37.4, 100)).toBe("37%");
  });

  it("says how long ago", () => {
    const now = Date.UTC(2026, 8, 28, 12);
    expect(formatAgo(now - 10_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAgo(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(formatAgo(now - 26 * 3600_000, now)).toBe("yesterday");
    expect(formatAgo(now - 3 * 86400_000, now)).toBe("3 days ago");
  });

  it("says spans and deadlines coarsely", () => {
    expect(formatDuration(30)).toBe("30 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3 * 3600)).toBe("3 h");
    expect(formatDuration(5 * 86400)).toBe("5 days");
    const now = 0;
    expect(formatUntil(7 * 86400_000, now)).toBe("in 7 days");
    expect(formatUntil(30_000, now)).toBe("in under a minute");
  });

  it("counts cores and things", () => {
    expect(formatCores(0.42, 8)).toBe("0.4 of 8 cores");
    expect(formatCores(3, 8)).toBe("3 of 8 cores");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
    expect(plural(2, "process", "processes")).toBe("2 processes");
  });

  it("greets for the time of day", () => {
    expect(greeting(new Date(2026, 0, 1, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 0, 1, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 0, 1, 21))).toBe("Good evening");
  });
});
