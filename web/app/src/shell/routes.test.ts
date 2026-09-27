import { describe, expect, it } from "vitest";
import { decodeSegment, encodeSegment, parseRoute, pathFor, type Route } from "./routes.ts";

const parse = (url: string): Route => {
  const u = new URL(url, "http://box");
  return parseRoute(u.pathname, u.search);
};

describe("parseRoute", () => {
  it("maps each surface's own path", () => {
    expect(parse("/")).toEqual({ surface: "home" });
    expect(parse("/workbench")).toEqual({ surface: "workbench" });
    expect(parse("/editor")).toEqual({ surface: "editor" });
    expect(parse("/apps")).toEqual({ surface: "apps" });
    expect(parse("/system")).toEqual({ surface: "system", view: "overview" });
    expect(parse("/system/monitor")).toEqual({ surface: "system", view: "monitor" });
  });

  it("keeps a review key the agent's link carries", () => {
    expect(parse("/workbench?review=0a1b2c3d")).toEqual({ surface: "workbench", review: "0a1b2c3d" });
    // Anything that is not a key is ignored rather than trusted.
    expect(parse("/workbench?review=../../x")).toEqual({ surface: "workbench" });
  });

  it("reads a files path below the workspace, or below home with ~", () => {
    expect(parse("/files")).toEqual({ surface: "files", root: "workspace", rel: [] });
    expect(parse("/files/")).toEqual({ surface: "files", root: "workspace", rel: [] });
    expect(parse("/files/demo/src/a.ts")).toEqual({ surface: "files", root: "workspace", rel: ["demo", "src", "a.ts"] });
    expect(parse("/files/~")).toEqual({ surface: "files", root: "home", rel: [] });
    expect(parse("/files/~/.config")).toEqual({ surface: "files", root: "home", rel: [".config"] });
    expect(parse("/files?trash=1")).toEqual({ surface: "files", root: "workspace", rel: [], trash: true });
  });

  it("decodes names with spaces, unicode and reserved characters", () => {
    expect(parse("/files/my%20notes/caf%C3%A9%3Bv2.md")).toEqual({
      surface: "files",
      root: "workspace",
      rel: ["my notes", "café;v2.md"],
    });
  });

  it("takes the query form for a path the path form cannot carry", () => {
    expect(parse("/files?p=%2Fa%5Cb%2Fc")).toEqual({ surface: "files", root: "workspace", rel: ["a\\b", "c"] });
    expect(parse("/files?p=~%2Fx")).toEqual({ surface: "files", root: "home", rel: ["x"] });
  });

  it("drops dot segments rather than walking them", () => {
    // (A browser resolves them before the app sees the path; this is the raw form.)
    expect(parseRoute("/files/a/../b/./c")).toEqual({ surface: "files", root: "workspace", rel: ["a", "b", "c"] });
    expect(parseRoute("/files/%2E%2E/x")).toEqual({ surface: "files", root: "workspace", rel: ["x"] });
  });

  it("reads an app id and a settings section", () => {
    expect(parse("/apps/abcdefghijklmnopqrstuvwxyz")).toEqual({ surface: "apps", appId: "abcdefghijklmnopqrstuvwxyz" });
    expect(parse("/settings")).toEqual({ surface: "settings", section: "account" });
    expect(parse("/settings/cli")).toEqual({ surface: "settings", section: "cli" });
    expect(parse("/settings/appearance")).toEqual({ surface: "settings", section: "appearance" });
    expect(parse("/settings/nope")).toEqual({ surface: "settings", section: "account" });
  });

  it("sends anything unknown home", () => {
    expect(parse("/nowhere/at/all")).toEqual({ surface: "home" });
  });
});

describe("pathFor", () => {
  const cases: [Route, string][] = [
    [{ surface: "home" }, "/"],
    [{ surface: "workbench" }, "/workbench"],
    [{ surface: "editor" }, "/editor"],
    [{ surface: "files", root: "workspace", rel: [] }, "/files"],
    [{ surface: "files", root: "workspace", rel: ["demo", "a b.txt"] }, "/files/demo/a%20b.txt"],
    [{ surface: "files", root: "home", rel: [] }, "/files/~"],
    [{ surface: "files", root: "home", rel: [".ssh"] }, "/files/~/.ssh"],
    [{ surface: "files", root: "workspace", rel: [], trash: true }, "/files?trash=1"],
    [{ surface: "apps" }, "/apps"],
    [{ surface: "apps", appId: "abc" }, "/apps/abc"],
    [{ surface: "system", view: "overview" }, "/system"],
    [{ surface: "system", view: "monitor" }, "/system/monitor"],
    [{ surface: "settings", section: "account" }, "/settings/account"],
    [{ surface: "settings", section: "cli" }, "/settings/cli"],
  ];
  it.each(cases)("%j → %s", (route, path) => {
    expect(pathFor(route)).toBe(path);
  });

  it("round-trips every files path through the URL", () => {
    const names = ["plain", "with space", "semi;colon", "per%cent", "ü", "a?b#c", "…", "\udcff-raw"];
    for (const name of names) {
      const route: Route = { surface: "files", root: "workspace", rel: ["dir", name] };
      expect(parse(pathFor(route))).toEqual(route);
    }
  });

  it("never emits a path the gate would refuse", () => {
    // The gate refuses %2e, %2f, %5c, a backslash, ";" and "//" in a raw path.
    const refused = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|;|\/\//i;
    for (const name of ["a\\b", "semi;colon", ".hidden", "x..y"]) {
      const path = pathFor({ surface: "files", root: "workspace", rel: [name] });
      expect(path.split("?")[0]).not.toMatch(refused);
    }
    // A backslash cannot travel in the path at all, so that one uses the query.
    expect(pathFor({ surface: "files", root: "workspace", rel: ["a\\b"] })).toBe("/files?p=%2Fa%5Cb");
  });
});

describe("segments", () => {
  it("keeps a raw byte as its lone surrogate", () => {
    expect(encodeSegment("\udcff")).toBe("%FF");
    expect(decodeSegment("%FF")).toBe("\udcff");
    expect(decodeSegment("caf%C3%A9")).toBe("café");
  });
});
