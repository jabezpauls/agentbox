import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme.ts";

function mockSystem(dark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: dark && query.includes("dark"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  mockSystem(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("defaults to system and applies no data-theme attribute", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("resolves system to the OS preference", () => {
    mockSystem(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe("dark");
  });

  it("cycles system -> light -> dark -> system", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.cycle());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => result.current.cycle());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    act(() => result.current.cycle());
    expect(result.current.theme).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("persists the choice under workbench.theme", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.cycle());
    expect(localStorage.getItem("workbench.theme")).toBe("light");
  });

  it("restores a saved choice", () => {
    localStorage.setItem("workbench.theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
