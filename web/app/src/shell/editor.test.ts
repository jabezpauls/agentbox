import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followAppTheme, openInEditor } from "./editor.ts";
import { useRouter } from "./router.ts";

const calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(url.endsWith("/open") ? { delivered: true } : { theme: "dark" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  useRouter.setState({ route: { surface: "files", path: "" }, mounted: ["files"], last: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("the app's side of the editor channel", () => {
  it("tells the editor the app's resolved theme", async () => {
    await followAppTheme("dark");
    expect(calls).toEqual([{ url: "/api/editor/theme", body: { kind: "dark" } }]);
  });

  it("asks for a fresh window when it brings its own editor forward", async () => {
    await openInEditor("/workspace/demo/README.md", { line: 3 });
    expect(useRouter.getState().route.surface).toBe("editor");
    expect(calls[0]).toMatchObject({ url: "/api/editor/open", body: { path: "/workspace/demo/README.md", line: 3, fresh: true } });
  });

  it("keeps quiet when the bridge cannot take the theme", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(followAppTheme("light")).resolves.toBeUndefined();
  });
});
