import { describe, it, expect } from "vitest";
import { isBackpressured } from "../src/routes/terminal-ws.js";

describe("isBackpressured", () => {
  it("passes a viewer whose send buffer is within the limit", () => {
    expect(isBackpressured(0, 1000)).toBe(false);
    expect(isBackpressured(1000, 1000)).toBe(false);
  });

  it("trips once the buffer grows past the limit", () => {
    expect(isBackpressured(1001, 1000)).toBe(true);
  });

  it("defaults to a bounded 8 MiB high-water mark", () => {
    expect(isBackpressured(8 * 1024 * 1024)).toBe(false);
    expect(isBackpressured(8 * 1024 * 1024 + 1)).toBe(true);
  });
});
