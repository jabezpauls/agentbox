import { describe, expect, it } from "vitest";
import { previewKind, renderMarkdown } from "./preview.ts";

const f = (name: string, type: "file" | "dir" | "symlink" = "file", targetType?: "file" | "dir") => ({
  name,
  type,
  ...(targetType ? { targetType } : {}),
});

describe("previewKind", () => {
  it("frames pictures and PDFs, renders Markdown, reads the rest as text", () => {
    expect(previewKind(f("a.png"))).toBe("image");
    expect(previewKind(f("A.JPG"))).toBe("image");
    expect(previewKind(f("paper.pdf"))).toBe("pdf");
    expect(previewKind(f("README.md"))).toBe("markdown");
    expect(previewKind(f("main.ts"))).toBe("text");
    expect(previewKind(f("Makefile"))).toBe("text");
  });

  it("shows HTML and SVG as their source, never as a page", () => {
    expect(previewKind(f("index.html"))).toBe("text");
    expect(previewKind(f("logo.svg"))).toBe("text");
  });

  it("does not try binaries or folders", () => {
    expect(previewKind(f("a.zip"))).toBe("none");
    expect(previewKind(f("src", "dir"))).toBe("none");
    expect(previewKind(f("link", "symlink", "dir"))).toBe("none");
    expect(previewKind(f("link.md", "symlink", "file"))).toBe("markdown");
  });
});

describe("renderMarkdown", () => {
  it("renders, and removes anything that could run", () => {
    const html = renderMarkdown(
      '# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<svg onload="alert(3)"><circle/></svg>\n\n[x](javascript:alert(4))\n\n<iframe src="/"></iframe>',
      "/workspace/demo/README.md",
    );
    expect(html).toContain("<h1");
    expect(html).not.toMatch(/<script|onerror|onload|<svg|javascript:|<iframe/i);
  });

  it("opens links in a new tab without a referrer", () => {
    const html = renderMarkdown("[site](https://example.com)", "/w/README.md");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows a relative picture from the files API", () => {
    const html = renderMarkdown("![logo](./img/logo.png)", "/workspace/demo/README.md");
    expect(html).toContain("/api/files/raw?path=%2Fworkspace%2Fdemo%2Fimg%2Flogo.png&amp;inline=1");
  });
});
