import { describe, expect, it } from "vitest";
import { isFullScreen } from "./fullscreen.ts";

describe("isFullScreen", () => {
  it("knows the usual full-screen programs, by name or by path", () => {
    expect(isFullScreen({ foreground_processes: [{ name: "nvim" }] })).toBe(true);
    expect(isFullScreen({ foreground_processes: [{ name: "git" }, { name: "x", argv0: "/usr/bin/less" }] })).toBe(true);
  });

  it("leaves a shell, a REPL or a plain command alone", () => {
    expect(isFullScreen({ foreground_processes: [{ name: "bash" }] })).toBe(false);
    expect(isFullScreen({ foreground_processes: [{ name: "python3" }, { name: "sleep" }] })).toBe(false);
    expect(isFullScreen({})).toBe(false);
    expect(isFullScreen(undefined)).toBe(false);
  });
});
