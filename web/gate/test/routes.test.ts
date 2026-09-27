import { describe, expect, it } from "vitest";
import { canonicalPath, isRoutablePath, isStrictPath, splitTarget } from "../src/path-guard.js";
import { route } from "../src/routes.js";

function at(url: string) {
  const { path, query } = splitTarget(url);
  return route(canonicalPath(path), query);
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

  it("holds only the WebDAV mount's prefix to the strict form", () => {
    // Filenames may hold ; a backslash or a % sequence; the bridge's WebDAV
    // handler judges each segment itself.
    for (const p of ["/api/dav", "/api/dav/", "/api/dav/a;b", "/api/dav/a%5Cb", "/api/dav/a\\b", "/api/dav/x%2fy", "/api/dav/..%2f..%2fvscode/", "/api/dav/../../vscode/", "/api/dav//x"]) {
      expect(isRoutablePath(p), p).toBe(true);
    }
    // Only that exact prefix: anything resembling it is still judged whole.
    for (const p of ["/api/davx;y", "/api/dav;x/", "/api%2fdav/a;b", "//api/dav/a;b", "/./api/dav/a;b", "/API/DAV/a;b", "/api/../api/dav/a;b"]) {
      expect(isRoutablePath(p), p).toBe(false);
    }
  });

  it("reads an escaped ordinary character as the character, so an upstream's router cannot read it differently", () => {
    // The bridge's router decodes %65 to e; routed raw, /ws/%65ditor would be
    // a path the gate had never judged.
    expect(canonicalPath("/ws/%65ditor")).toBe("/ws/editor");
    expect(canonicalPath("/%77s/editor")).toBe("/ws/editor");
    expect(canonicalPath("/%76%73code/")).toBe("/vscode/");
    expect(canonicalPath("/a%2Db%5F%7Ec%30")).toBe("/a-b_~c0");
    // Reserved and other characters keep their escape: they mean something else decoded.
    expect(canonicalPath("/x%20y%25z%3F%23%40")).toBe("/x%20y%25z%3F%23%40");
    // A dot is never decoded (the guard refuses %2e anyway): it could make a dot-segment.
    expect(canonicalPath("/x%2ey")).toBe("/x%2ey");
    // The WebDAV mount's names go as sent.
    expect(canonicalPath("/api/dav/%41%3B")).toBe("/api/dav/%41%3B");
    expect(canonicalPath("/api/%64av/x")).toBe("/api/dav/x");
  });

  it("holds a path to the strict form, with no exemption, where one is asked for", () => {
    expect(isStrictPath("/workbench/")).toBe(true);
    for (const p of ["/api/dav/a;b", "/api/dav/..%2fvscode/", "/api/dav/../x", "//x", "x"]) {
      expect(isStrictPath(p), p).toBe(false);
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
    for (const u of [
      "/login",
      "/login?next=/x",
      "/login/assets/login.css",
      "/_gate/login",
      "/_gate/anything",
      "/cli/install",
      "/cli/agentbox.mjs",
      "/cli/install?x=1",
      "/settings/devices?code=AAAA-BBBB",
    ]) {
      expect(at(u), u).toEqual({ kind: "gate" });
    }
  });

  it("keeps exactly the CLI's two files, and nothing else under /cli", () => {
    for (const u of ["/cli", "/cli/", "/cli/other", "/cli/install/", "/cli/install/x", "/cli/agentbox.mjs.map", "/cli/Install", "/clix"]) {
      expect(at(u), u).toEqual({ kind: "upstream", upstream: "bridge", target: u });
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

  it("sends everything under the WebDAV mount to the bridge, raw, and nowhere else", () => {
    for (const u of [
      "/api/dav/a;b",
      "/api/dav/..%2f..%2fvscode/",
      "/api/dav/../../vscode/",
      "/api/dav/%2e%2e/%2e%2e/terminal/",
      "/api/dav/..%2f..%2f_gate/login",
      "/api/dav/x?y=..%2f",
    ]) {
      const { path } = splitTarget(u);
      expect(isRoutablePath(path), u).toBe(true);
      expect(at(u), u).toEqual({ kind: "upstream", upstream: "bridge", target: u });
    }
  });

  it("does not serve the editor channel from outside", () => {
    for (const u of ["/ws/editor", "/ws/editor/", "/ws/editor/x", "/ws/editor?x=1"]) {
      expect(at(u), u).toEqual({ kind: "notFound" });
    }
    for (const u of ["/ws/%65ditor", "/%77s/editor", "/ws/%65%64itor/x", "/%77%73/%65%64%69%74%6f%72"]) {
      expect(at(u), u).toEqual({ kind: "notFound" });
    }
    expect(at("/ws/events")).toEqual({ kind: "upstream", upstream: "bridge", target: "/ws/events" });
    expect(at("/ws/editorial")).toEqual({ kind: "upstream", upstream: "bridge", target: "/ws/editorial" });
  });

  it("sends everything else to the bridge, path untouched", () => {
    expect(at("/")).toEqual({ kind: "upstream", upstream: "bridge", target: "/" });
    expect(at("/workbench/api/health")).toEqual({ kind: "upstream", upstream: "bridge", target: "/workbench/api/health" });
    expect(at("/api/files/list?path=/a%20b")).toEqual({ kind: "upstream", upstream: "bridge", target: "/api/files/list?path=/a%20b" });
    expect(at("/settings/other")).toEqual({ kind: "upstream", upstream: "bridge", target: "/settings/other" });
  });
});
