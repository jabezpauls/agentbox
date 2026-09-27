import { describe, expect, it } from "vitest";
import { isRoutablePath, splitTarget } from "../src/path-guard.js";
import { route } from "../src/routes.js";

function at(url: string) {
  const { path, query } = splitTarget(url);
  return route(path, query);
}

describe("the path guard", () => {
  it("refuses every form two parsers could read differently", () => {
    for (const p of [
      "/..",
      "/../x",
      "/a/../b",
      "/a/./b",
      "/.",
      "/a/..",
      "/%2e%2e/x",
      "/%2E%2E/x",
      "/a%2fb",
      "/a%2Fb",
      "/a%5cb",
      "/a\\b",
      "/a;b",
      "//a",
      "/a//b",
      "*",
      "http://evil.example/x",
      "",
    ]) {
      expect(isRoutablePath(p), p).toBe(false);
    }
  });

  it("lets ordinary paths through, dots inside names included", () => {
    for (const p of ["/", "/vscode/", "/workbench/api/health", "/a/b.c/d", "/.well-known/x", "/a..b", "/x%20y"]) {
      expect(isRoutablePath(p), p).toBe(true);
    }
  });

  it("splits the query off at the first ?, keeping both raw", () => {
    expect(splitTarget("/a?b=1?c")).toEqual({ path: "/a", query: "b=1?c" });
    expect(splitTarget("/a")).toEqual({ path: "/a", query: null });
    expect(splitTarget("/a?")).toEqual({ path: "/a", query: "" });
  });
});

describe("the route table", () => {
  it("keeps the gate's own paths", () => {
    for (const u of ["/login", "/login?next=/x", "/login/assets/login.css", "/_gate/login", "/_gate/anything", "/cli/install", "/settings/devices?code=AAAA-BBBB"]) {
      expect(at(u), u).toEqual({ kind: "gate" });
    }
  });

  it("serves the editor under /vscode/ with the prefix stripped", () => {
    expect(at("/vscode/")).toEqual({ kind: "upstream", upstream: "code", target: "/" });
    expect(at("/vscode/static/out/x.js?v=1")).toEqual({ kind: "upstream", upstream: "code", target: "/static/out/x.js?v=1" });
    expect(at("/vscode")).toEqual({ kind: "redirect", location: "/vscode/" });
    expect(at("/vscode?folder=/workspace")).toEqual({ kind: "redirect", location: "/vscode/?folder=/workspace" });
  });

  it("forwards the ttyd paths unchanged", () => {
    expect(at("/terminal/")).toEqual({ kind: "upstream", upstream: "terminal", target: "/terminal/" });
    expect(at("/terminal/ws?x=1")).toEqual({ kind: "upstream", upstream: "terminal", target: "/terminal/ws?x=1" });
    expect(at("/shell")).toEqual({ kind: "upstream", upstream: "shell", target: "/shell" });
    expect(at("/monitor/token")).toEqual({ kind: "upstream", upstream: "monitor", target: "/monitor/token" });
  });

  it("matches whole segments only", () => {
    expect(at("/shellfish")).toEqual({ kind: "upstream", upstream: "bridge", target: "/shellfish" });
    expect(at("/loginx")).toEqual({ kind: "upstream", upstream: "bridge", target: "/loginx" });
    expect(at("/vscodex/")).toEqual({ kind: "upstream", upstream: "bridge", target: "/vscodex/" });
    expect(at("/_gatex")).toEqual({ kind: "upstream", upstream: "bridge", target: "/_gatex" });
  });

  it("sends everything else to the bridge, path untouched", () => {
    expect(at("/")).toEqual({ kind: "upstream", upstream: "bridge", target: "/" });
    expect(at("/workbench/api/health")).toEqual({ kind: "upstream", upstream: "bridge", target: "/workbench/api/health" });
    expect(at("/api/files/list?path=/a%20b")).toEqual({ kind: "upstream", upstream: "bridge", target: "/api/files/list?path=/a%20b" });
    expect(at("/settings/other")).toEqual({ kind: "upstream", upstream: "bridge", target: "/settings/other" });
  });
});
