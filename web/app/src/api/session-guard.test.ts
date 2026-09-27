import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionGuard, isSignInRequired, loginUrl } from "./session-guard.ts";

function fakeWindow(responses: Response[]) {
  const assign = vi.fn();
  const listeners: Record<string, () => void> = {};
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response("{}"));
  const win = {
    fetch: fetchMock,
    location: { pathname: "/workbench/", search: "?review=abc", assign },
    document: {
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
    },
  };
  return { win: win as unknown as Window & typeof globalThis, assign, fetchMock, listeners };
}

const signInFirst = () => new Response("sign in first", { status: 401, headers: { "x-agentbox-login": "/login" } });

afterEach(() => vi.restoreAllMocks());

describe("the session guard", () => {
  it("builds a sign-in link that comes back to the same place", () => {
    expect(loginUrl({ pathname: "/workbench/", search: "?review=abc" })).toBe("/login?next=%2Fworkbench%2F%3Freview%3Dabc");
  });

  it("tells the gate's answer apart from any other 401", () => {
    expect(isSignInRequired(signInFirst())).toBe(true);
    expect(isSignInRequired(new Response("", { status: 401 }))).toBe(false);
    expect(isSignInRequired(new Response("", { status: 200, headers: { "x-agentbox-login": "/login" } }))).toBe(false);
  });

  it("sends the page to sign in once, and still hands the response back", async () => {
    const { win, assign } = fakeWindow([signInFirst(), signInFirst()]);
    installSessionGuard(win);
    const res = await win.fetch("/workbench/api/health");
    expect(res.status).toBe(401);
    await win.fetch("/workbench/api/health");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login?next=%2Fworkbench%2F%3Freview%3Dabc");
  });

  it("leaves ordinary answers alone", async () => {
    const { win, assign } = fakeWindow([new Response("{}"), new Response("nope", { status: 401 })]);
    installSessionGuard(win);
    await win.fetch("/a");
    await win.fetch("/b");
    expect(assign).not.toHaveBeenCalled();
  });

  it("checks the session when the tab comes back into view", async () => {
    const { win, fetchMock, listeners, assign } = fakeWindow([signInFirst()]);
    installSessionGuard(win);
    listeners.visibilitychange?.();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/_gate/session", expect.anything());
  });
});
