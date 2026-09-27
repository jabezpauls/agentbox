import { describe, expect, it } from "vitest";
import { previewTarget, previewUrl } from "./url.ts";

describe("previewUrl", () => {
  it("builds a proxied path with the leading slash removed", () => {
    expect(previewUrl(3005, "/app/page")).toBe("/preview/3005/app/page");
  });

  it("preserves the query string", () => {
    expect(previewUrl(3005, "/app?q=1&x=2")).toBe("/preview/3005/app?q=1&x=2");
  });

  it("normalises a bare root path", () => {
    expect(previewUrl(3005, "/")).toBe("/preview/3005/");
    expect(previewUrl(8080, "")).toBe("/preview/8080/");
  });
});

describe("previewTarget", () => {
  it("uses the preview domain as a subdomain when configured", () => {
    expect(previewTarget(3005, "/app?q=1", "preview.example.com")).toBe("https://3005.preview.example.com/app?q=1");
  });

  it("falls back to the proxied path when no domain is configured", () => {
    expect(previewTarget(3005, "/app", null)).toBe("/preview/3005/app");
  });
});
