import { beforeEach, describe, expect, it } from "vitest";
import { emptySession } from "../store/session.ts";
import { useRouter } from "../shell/router.ts";
import { useRequests } from "../shell/requests.ts";
import { SURFACES } from "../shell/surfaces.ts";
import { buildItems } from "./items.ts";
import { paletteEffects } from "./effects.ts";

const sources = () => ({ session: emptySession(), projects: [], apps: [], reviews: [], files: null, workspaceRoot: "/workspace" });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  useRouter.setState({ route: { surface: "home" }, mounted: ["home"], last: {} });
});

describe("the palette's choices, with the app's real effects", () => {
  it("runs every surface entry without error, landing on that surface", () => {
    const items = buildItems(sources(), paletteEffects, "all", "").filter((i) => i.kind === "surface");
    expect(items.map((i) => i.id)).toEqual(SURFACES.map((s) => `surface:${s.id}`));
    for (const item of items) {
      expect(() => item.run()).not.toThrow();
      expect(`surface:${useRouter.getState().route.surface}`).toBe(item.id);
    }
    // Every one of them left a real address behind.
    expect(window.location.pathname).toBe("/settings/account");
  });

  it("goes back to the folder Files was left in, as the rail does", () => {
    useRouter.getState().navigate({ surface: "files", path: "/workspace/demo/src" });
    useRouter.getState().navigate({ surface: "home" });
    buildItems(sources(), paletteEffects, "all", "files")
      .find((i) => i.id === "surface:files")!
      .run();
    expect(window.location.pathname).toBe("/files/workspace/demo/src");
  });

  it("leaves New project waiting for Home, even when Home has not been built", () => {
    useRouter.getState().navigate({ surface: "system", view: "overview" });
    buildItems(sources(), paletteEffects, "all", "new project")
      .find((i) => i.label === "New project")!
      .run();
    expect(useRouter.getState().route.surface).toBe("home");
    expect(useRequests.getState().newProject).toBe("clone");
  });
});
