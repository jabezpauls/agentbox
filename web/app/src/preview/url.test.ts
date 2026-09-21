import { describe, expect, it } from "vitest";
import { fullScreenUrl, previewUrl } from "./url.ts";

describe("previewUrl", () => {
  it("builds a proxied path under the base with the leading slash removed", () => {
    expect(previewUrl("/workbench", 3005, "/app/page")).toBe("/workbench/preview/3005/app/page");
  });

  it("preserves the query string", () => {
    expect(previewUrl("/workbench", 3005, "/app?q=1&x=2")).toBe("/workbench/preview/3005/app?q=1&x=2");
  });

  it("normalises a bare root path", () => {
    expect(previewUrl("/workbench", 3005, "/")).toBe("/workbench/preview/3005/");
    expect(previewUrl("", 8080, "")).toBe("/preview/8080/");
  });
});

describe("fullScreenUrl", () => {
  it("uses the preview domain as a subdomain when configured", () => {
    expect(fullScreenUrl(3005, "/app?q=1", "preview.example.com", "/workbench")).toBe(
      "https://3005.preview.example.com/app?q=1",
    );
  });

  it("falls back to the proxied path when no domain is configured", () => {
    expect(fullScreenUrl(3005, "/app", null, "/workbench")).toBe("/workbench/preview/3005/app");
  });
});
