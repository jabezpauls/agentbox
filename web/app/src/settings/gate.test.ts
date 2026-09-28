import { describe, expect, it } from "vitest";
import { describeAgent } from "./gate.ts";

describe("describeAgent", () => {
  it("names the browser and the system", () => {
    expect(describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36")).toBe(
      "Chrome on macOS",
    );
    expect(describeAgent("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Linux");
    expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe(
      "Safari on iOS",
    );
    expect(describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0")).toBe(
      "Edge on Windows",
    );
  });

  it("says what it cannot tell", () => {
    expect(describeAgent("")).toBe("Unknown browser");
    expect(describeAgent("curl/8.5.0")).toBe("curl");
  });
});
