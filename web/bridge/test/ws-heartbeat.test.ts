import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeat, type Pingable } from "../src/ws-heartbeat.js";

function fakeSocket() {
  const listeners: Record<string, (() => void)[]> = {};
  const s = {
    readyState: 1,
    OPEN: 1,
    ping: vi.fn(),
    terminate: vi.fn(),
    on(event: string, fn: () => void) {
      (listeners[event] ??= []).push(fn);
      return s;
    },
    emit(event: string) {
      for (const fn of listeners[event] ?? []) fn();
    },
  };
  return s satisfies Pingable & { emit(e: string): void };
}

describe("heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings an open socket every interval while it answers", () => {
    const s = fakeSocket();
    heartbeat(s, 1000);
    vi.advanceTimersByTime(1000);
    expect(s.ping).toHaveBeenCalledTimes(1);
    s.emit("pong");
    vi.advanceTimersByTime(1000);
    s.emit("pong");
    vi.advanceTimersByTime(1000);
    expect(s.ping).toHaveBeenCalledTimes(3);
    expect(s.terminate).not.toHaveBeenCalled();
  });

  it("ends a socket that stopped answering", () => {
    const s = fakeSocket();
    heartbeat(s, 1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(s.terminate).toHaveBeenCalledTimes(1);
  });

  it("stops once the socket closes", () => {
    const s = fakeSocket();
    heartbeat(s, 1000);
    s.emit("close");
    vi.advanceTimersByTime(5000);
    expect(s.ping).not.toHaveBeenCalled();
  });
});
