import { describe, expect, it } from "vitest";
import { basename, dirname, freeName, isWithin, join, nameProblem, numberedName, splitExt, toAbsolute, toRelative } from "./paths.ts";

const roots = { workspace: "/workspace", home: "/home/coder" };

describe("paths", () => {
  it("splits and joins", () => {
    expect(basename("/workspace/demo/a.ts")).toBe("a.ts");
    expect(basename("/workspace/demo/")).toBe("demo");
    expect(dirname("/workspace/demo/a.ts")).toBe("/workspace/demo");
    expect(dirname("/workspace")).toBe("/");
    expect(join("/workspace/", "x")).toBe("/workspace/x");
    expect(join("/", "x")).toBe("/x");
  });

  it("knows what is inside what", () => {
    expect(isWithin("/workspace/demo", "/workspace")).toBe(true);
    expect(isWithin("/workspace", "/workspace")).toBe(true);
    expect(isWithin("/workspaces", "/workspace")).toBe(false);
  });

  it("maps routes to paths and back", () => {
    expect(toAbsolute(roots, "workspace", ["demo", "src"])).toBe("/workspace/demo/src");
    expect(toAbsolute(roots, "home", [])).toBe("/home/coder");
    expect(toRelative(roots, "/workspace/demo/src")).toEqual({ root: "workspace", rel: ["demo", "src"] });
    expect(toRelative(roots, "/home/coder/.ssh")).toEqual({ root: "home", rel: [".ssh"] });
    expect(toRelative(roots, "/etc/passwd")).toBeNull();
  });

  it("keeps the extension out of a rename", () => {
    expect(splitExt("a.test.ts")).toEqual(["a.test", ".ts"]);
    expect(splitExt(".bashrc")).toEqual([".bashrc", ""]);
    expect(splitExt("Makefile")).toEqual(["Makefile", ""]);
  });

  it("refuses names that are not names", () => {
    expect(nameProblem("ok.txt")).toBeNull();
    expect(nameProblem("a/b")).toMatch(/slash/);
    expect(nameProblem("..")).not.toBeNull();
    expect(nameProblem("  ")).not.toBeNull();
  });

  it("finds a free name", () => {
    expect(freeName("notes.md", new Set())).toBe("notes copy.md");
    expect(freeName("notes.md", new Set(["notes copy.md"]))).toBe("notes copy 2.md");
    expect(numberedName("photo.jpg", 2)).toBe("photo (2).jpg");
  });
});
