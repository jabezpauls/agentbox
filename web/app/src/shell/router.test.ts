import { beforeEach, describe, expect, it } from "vitest";
import { installRouter, useRouter } from "./router.ts";

function at(path: string) {
  window.history.replaceState(null, "", path);
  useRouter.getState().sync();
}

beforeEach(() => {
  useRouter.setState({ last: {}, mounted: [] });
  at("/");
});

describe("router", () => {
  it("puts every navigation in the address bar and the history", () => {
    const before = window.history.length;
    useRouter.getState().navigate({ surface: "files", path: "/workspace/demo" });
    expect(window.location.pathname).toBe("/files/workspace/demo");
    expect(window.history.length).toBe(before + 1);
    expect(useRouter.getState().route).toEqual({ surface: "files", path: "/workspace/demo" });
  });

  it("does not stack a second entry for the same place", () => {
    useRouter.getState().navigate({ surface: "apps" });
    const before = window.history.length;
    useRouter.getState().navigate({ surface: "apps" });
    expect(window.history.length).toBe(before);
  });

  it("replaces instead of pushing when asked", () => {
    const before = window.history.length;
    useRouter.getState().navigate({ surface: "editor" }, { replace: true });
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/editor");
  });

  it("takes the route from the address bar on back and forward", () => {
    const dispose = installRouter(window);
    window.history.pushState(null, "", "/system/monitor");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(useRouter.getState().route).toEqual({ surface: "system", view: "monitor" });
    dispose();
  });

  it("returns to where a surface was left", () => {
    const r = useRouter.getState();
    r.navigate({ surface: "files", path: "/workspace/demo/src" });
    r.navigate({ surface: "home" });
    useRouter.getState().go("files");
    expect(useRouter.getState().route).toEqual({ surface: "files", path: "/workspace/demo/src" });
    useRouter.getState().go("settings");
    expect(useRouter.getState().route).toEqual({ surface: "settings", section: "account" });
  });

  it("keeps every visited surface mounted", () => {
    const r = useRouter.getState();
    r.navigate({ surface: "workbench" });
    r.navigate({ surface: "editor" });
    r.navigate({ surface: "home" });
    expect(useRouter.getState().mounted).toEqual(expect.arrayContaining(["home", "workbench", "editor"]));
  });

  it("normalises the typed path without adding history", () => {
    window.history.replaceState(null, "", "/settings");
    useRouter.getState().sync();
    const before = window.history.length;
    const dispose = installRouter(window);
    expect(window.location.pathname).toBe("/settings/account");
    expect(window.history.length).toBe(before);
    dispose();
  });
});
