import { describe, expect, it } from "vitest";
import { appLink, appUrl, forwardCommand, normalisePath } from "./url.ts";

const ID = "abcdefghijklmnopqrstuvwxyz";

describe("an app's URL", () => {
  it("puts the path under the app, keeping the query", () => {
    expect(appUrl(ID, "/app/page")).toBe(`/a/${ID}/app/page`);
    expect(appUrl(ID, "/app?q=1&x=2")).toBe(`/a/${ID}/app?q=1&x=2`);
    expect(appUrl(ID, "about")).toBe(`/a/${ID}/about`);
  });

  it("is the app's root for an empty or bare path", () => {
    expect(appUrl(ID)).toBe(`/a/${ID}/`);
    expect(appUrl(ID, "")).toBe(`/a/${ID}/`);
    expect(appUrl(ID, "//x")).toBe(`/a/${ID}/x`);
  });

  it("is a full link on the page's own origin", () => {
    expect(appLink(ID, "https://box.example")).toBe(`https://box.example/a/${ID}/`);
  });
});

describe("the helpers", () => {
  it("normalise a typed path", () => {
    expect(normalisePath("  ")).toBe("/");
    expect(normalisePath("x")).toBe("/x");
    expect(normalisePath("/x")).toBe("/x");
  });

  it("say how to open the app on your own machine", () => {
    expect(forwardCommand(5173)).toBe("agentbox forward 5173");
  });
});
