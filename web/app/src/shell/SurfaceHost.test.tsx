import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling, useSurfaceActive } from "./activity.tsx";
import { useRouter } from "./router.ts";
import type { SurfaceId } from "./routes.ts";
import { SurfaceHost } from "./SurfaceHost.tsx";
import { lazySurface } from "./lazySurface.tsx";

const mounts: Record<string, number> = {};

function Probe({ id }: { id: SurfaceId }) {
  const active = useSurfaceActive();
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
  }, [id]);
  return <p data-testid={`probe-${id}`}>{active ? "active" : "hidden"}</p>;
}

const renderers = Object.fromEntries(
  (["home", "workbench", "editor", "files", "apps", "system", "settings"] as SurfaceId[]).map((id) => [id, () => <Probe id={id} />]),
) as Record<SurfaceId, () => React.ReactNode>;

beforeEach(() => {
  for (const k of Object.keys(mounts)) delete mounts[k];
  window.history.replaceState(null, "", "/");
  useRouter.setState({ route: { surface: "home" }, mounted: ["home"], last: {} });
});

describe("SurfaceHost with surfaces fetched on first visit", () => {
  it("shows a surface once its code arrives, and imports it again on Try again when it cannot", async () => {
    let arrive: (c: React.ComponentType) => void = () => {};
    const Late = lazySurface(() => new Promise<React.ComponentType>((r) => (arrive = r)));
    let attempts = 0;
    const Flaky = lazySurface<object>(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new TypeError("Failed to fetch dynamically imported module")) : Promise.resolve(() => <p>apps are here</p>);
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<SurfaceHost render={{ ...renderers, files: () => <Late />, apps: () => <Flaky /> }} />);

    act(() => useRouter.getState().navigate({ surface: "files", path: "" }));
    expect(screen.getByLabelText("Loading Files")).toHaveAttribute("aria-busy", "true");
    await act(async () => arrive(() => <p>files are here</p>));
    expect(await screen.findByText("files are here")).toBeInTheDocument();

    act(() => useRouter.getState().navigate({ surface: "apps" }));
    expect(await screen.findByText("Couldn't load this part of the app.")).toBeInTheDocument();
    await act(async () => screen.getByRole("button", { name: "Try again" }).click());
    expect(await screen.findByText("apps are here")).toBeInTheDocument();
    expect(attempts).toBe(2);
    // Without reloading the page, which would drop the uploads under way.
    expect(reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("SurfaceHost", () => {
  it("builds a surface on first visit and keeps it through every switch", () => {
    render(<SurfaceHost render={renderers} />);
    expect(screen.queryByTestId("probe-editor")).toBeNull();

    act(() => useRouter.getState().navigate({ surface: "editor" }));
    expect(screen.getByTestId("probe-editor")).toHaveTextContent("active");
    expect(screen.getByTestId("probe-home")).toHaveTextContent("hidden");

    act(() => useRouter.getState().navigate({ surface: "home" }));
    act(() => useRouter.getState().navigate({ surface: "editor" }));
    act(() => useRouter.getState().navigate({ surface: "files", path: "" }));
    expect(mounts).toEqual({ home: 1, editor: 1, files: 1 });
  });

  it("takes hidden surfaces out of reach", () => {
    const { container } = render(<SurfaceHost render={renderers} />);
    act(() => useRouter.getState().navigate({ surface: "apps" }));
    const home = container.querySelector('[data-surface="home"]')!;
    const apps = container.querySelector('[data-surface="apps"]')!;
    expect(home).toHaveAttribute("aria-hidden", "true");
    expect(home.hasAttribute("inert")).toBe(true);
    expect(apps).not.toHaveAttribute("aria-hidden");
    expect(apps.hasAttribute("inert")).toBe(false);
  });

  it("never reorders the sections, so nothing already built moves", () => {
    const { container } = render(<SurfaceHost render={renderers} />);
    const before = [...container.querySelectorAll("section")];
    act(() => useRouter.getState().navigate({ surface: "system", view: "overview" }));
    const after = [...container.querySelectorAll("section")];
    expect(after).toEqual(before);
  });
});

describe("usePolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Poller({ fn }: { fn: () => void }) {
    usePolling(fn, 1000);
    return null;
  }

  it("polls only while its surface is showing", async () => {
    const fn = vi.fn();
    useRouter.setState({ route: { surface: "system", view: "overview" }, mounted: ["system"], last: {} });
    const r = { ...renderers, system: () => <Poller fn={fn} /> };
    render(<SurfaceHost render={r} />);
    await act(async () => {});
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(fn).toHaveBeenCalledTimes(4);

    act(() => useRouter.getState().navigate({ surface: "home" }));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fn).toHaveBeenCalledTimes(4);

    // Coming back reads straight away, then keeps the beat.
    act(() => useRouter.getState().navigate({ surface: "system", view: "overview" }));
    await act(async () => {});
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
