import { afterEach, describe, expect, it, vi } from "vitest";
import { appPageUrl, openAppFullScreen } from "./open.ts";
import type { AppView } from "./model.ts";

afterEach(() => vi.unstubAllGlobals());

describe("appPageUrl", () => {
  it("keeps an app's own path on this origin", () => {
    expect(appPageUrl("/a/site/")).toBe("/a/site/");
    expect(appPageUrl("/a/site/docs?x=1#top")).toBe("/a/site/docs?x=1#top");
  });

  it("refuses anything that is not a path under /a/", () => {
    for (const url of [
      "https://evil.example/",
      "//evil.example/a/",
      "javascript:alert(1)",
      "/a\\\\evil.example",
      "/settings",
      "/a/../settings",
      "a/site",
      "",
    ]) {
      expect(appPageUrl(url), url).toBeNull();
    }
  });
});

describe("openAppFullScreen", () => {
  it("never opens an address the bridge would not have given", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    openAppFullScreen({ url: "https://evil.example/" } as AppView);
    expect(open).not.toHaveBeenCalled();
    openAppFullScreen({ url: "/a/site/" } as AppView);
    expect(open).toHaveBeenCalledWith("/a/site/", "_blank", "noopener");
  });
});
