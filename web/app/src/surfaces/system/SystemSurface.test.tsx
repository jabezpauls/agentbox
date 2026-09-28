import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceActiveContext } from "../../shell/activity.tsx";
import { useRouter } from "../../shell/router.ts";
import { useSystem } from "../../system/model.ts";

vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
const { SystemSurface } = await import("./SystemSurface.tsx");

function Host({ active }: { active: boolean }) {
  return (
    <SurfaceActiveContext.Provider value={active}>
      <SystemSurface />
    </SurfaceActiveContext.Provider>
  );
}

const frame = () => document.querySelector('iframe[src="/monitor/"]');

beforeEach(() => {
  useSystem.setState({ info: null, error: null, history: [] });
  useRouter.setState({ route: { surface: "system", view: "monitor" }, mounted: ["system"], last: {} });
});

describe("the detailed monitor", () => {
  it("is loaded only while it is being looked at", () => {
    const { rerender } = render(<Host active />);
    expect(frame()).not.toBeNull();

    // Another surface: btop's stream stops.
    rerender(<Host active={false} />);
    expect(frame()).toBeNull();

    // Back: loaded afresh.
    rerender(<Host active />);
    expect(frame()).not.toBeNull();

    // The overview: not loaded behind it.
    act(() => useRouter.setState({ route: { surface: "system", view: "overview" } }));
    expect(frame()).toBeNull();
  });

  it("is unloaded while the browser tab is hidden", () => {
    render(<Host active />);
    expect(frame()).not.toBeNull();
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(frame()).toBeNull();
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(frame()).not.toBeNull();
  });
});
