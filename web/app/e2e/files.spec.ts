import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Cookie, type Page } from "@playwright/test";
import { resume, sharedSession } from "./session.ts";

/**
 * J4 — Files: drop a folder from the desktop, rename a file, download a
 * folder as a zip, send things to the trash and bring them back, and look
 * inside files without leaving the list.
 */

test.describe.configure({ mode: "serial" });

let client = 0;
let root = "";
let project = "";
let cookies: Cookie[] = [];

test.beforeAll(async ({ browser }) => {
  cookies = await sharedSession(browser, "203.0.113.140");
});

async function workspaceRoot(page: Page): Promise<string> {
  return page.evaluate(async () => ((await (await fetch("/api/health")).json()) as { workspaceRoot: string }).workspaceRoot);
}

/** The route for an absolute path, as the CLI and the app both spell it. */
const filesRoute = (abs: string) => `/files${abs.split("/").map(encodeURIComponent).join("/")}`;

const row = (page: Page, name: string) => page.getByRole("row", { name, exact: true });

test.beforeEach(async ({ page }) => {
  client += 1;
  await resume(page, cookies);
  root = await workspaceRoot(page);
  project = path.join(root, "files-e2e");
  if (client === 1) {
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(path.join(project, "docs"), { recursive: true });
    fs.writeFileSync(path.join(project, "README.md"), "# Files end to end\n\nSome *markdown*.\n");
    fs.writeFileSync(path.join(project, "notes.txt"), "line one\nline two\n");
    fs.writeFileSync(path.join(project, "docs", "guide.md"), "# Guide\n");
  }
});

test("a deep link to a folder lists it, and one to a file opens it in quick look", async ({ page }) => {
  await page.goto(filesRoute(project));
  await expect(row(page, "README.md")).toBeVisible();
  await expect(row(page, "docs")).toBeVisible();

  await page.goto(filesRoute(path.join(project, "README.md")));
  const look = page.getByRole("dialog", { name: /Quick look: README\.md/ });
  await expect(look).toBeVisible();
  // Markdown is rendered, not shown as source.
  await expect(look.getByRole("heading", { name: "Files end to end" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(look).toBeHidden();
  await expect(page).toHaveURL(filesRoute(project));
});

test("a folder dropped from the desktop is uploaded with everything in it", async ({ page }) => {
  await page.goto(filesRoute(project));
  await expect(row(page, "README.md")).toBeVisible();

  // A drop the way a browser delivers a dragged folder: entries reachable
  // only through webkitGetAsEntry, a directory reader that hands them over
  // in batches. (Playwright cannot drag from the real desktop.)
  await page.evaluate(() => {
    type Node = { name: string; text?: string; children?: Node[] };
    const entry = (n: Node): unknown =>
      n.children
        ? {
            name: n.name,
            isFile: false,
            isDirectory: true,
            createReader() {
              let done = false;
              return {
                readEntries(ok: (e: unknown[]) => void) {
                  const batch = done ? [] : n.children!.map(entry);
                  done = true;
                  setTimeout(() => ok(batch), 0);
                },
              };
            },
          }
        : { name: n.name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(new File([n.text ?? ""], n.name)) };
    const tree: Node = {
      name: "site",
      children: [
        { name: "index.html", text: "<h1>hello</h1>" },
        { name: "css", children: [{ name: "app.css", text: "body{}" }] },
        { name: "empty", children: [] },
      ],
    };
    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", webkitGetAsEntry: () => entry(tree), getAsFile: () => null }],
      files: [],
      dropEffect: "none",
      getData: () => "",
    };
    const target = document.querySelector('[data-surface="files"] .flist-scroll')!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
      target.dispatchEvent(ev);
    }
  });

  await expect(page.getByRole("region", { name: "Uploads" })).toContainText(/Uploaded 2 files/, { timeout: 20_000 });
  await expect(row(page, "site")).toBeVisible();
  expect(fs.readFileSync(path.join(project, "site", "index.html"), "utf8")).toBe("<h1>hello</h1>");
  expect(fs.readFileSync(path.join(project, "site", "css", "app.css"), "utf8")).toBe("body{}");
  expect(fs.statSync(path.join(project, "site", "empty")).isDirectory()).toBe(true);
});

/** Drag a loose file over `selector` and let go; true when the page took the drop (cancelled it). */
async function dropFileOn(page: Page, selector: string, name: string, text: string): Promise<boolean> {
  return page.evaluate(
    ({ selector, name, text }) => {
      const file = new File([text], name);
      const dataTransfer = {
        types: ["Files"],
        items: [{ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => file }],
        files: [file],
        dropEffect: "none",
        getData: () => "",
      };
      const target = document.querySelector(selector)!;
      let taken = false;
      for (const type of ["dragenter", "dragover", "drop"]) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
        const handled = !target.dispatchEvent(ev);
        if (type === "drop") taken = handled;
      }
      return taken;
    },
    { selector, name, text },
  );
}

test("a file let go anywhere on Files goes to the folder shown; elsewhere it is ignored", async ({ page }) => {
  await page.goto(filesRoute(project));
  await expect(row(page, "README.md")).toBeVisible();

  // The bar above the list, not the list: still the folder shown.
  expect(await dropFileOn(page, '[data-surface="files"] .files-bar', "from-the-bar.txt", "bar")).toBe(true);
  const uploads = page.getByRole("region", { name: "Uploads" });
  await expect(uploads).toContainText(/Uploaded/, { timeout: 20_000 });
  await expect(row(page, "from-the-bar.txt")).toBeVisible();
  expect(fs.readFileSync(path.join(project, "from-the-bar.txt"), "utf8")).toBe("bar");
  await uploads.getByRole("button", { name: "Dismiss uploads" }).click();

  // On Home the drop is swallowed — the browser does not open the file in
  // place of the app — and nothing is uploaded.
  await page.getByRole("link", { name: "Home" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  expect(await dropFileOn(page, '[data-surface="home"]', "stray.txt", "stray")).toBe(true);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Uploads" })).toHaveCount(0);
  expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(false);
});

test("files picked with Upload land in the folder shown, and a taken name asks first", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-e2e-pick-"));
  fs.writeFileSync(path.join(dir, "picked.txt"), "picked");
  fs.writeFileSync(path.join(dir, "notes.txt"), "replacement");
  await page.goto(filesRoute(project));
  await expect(row(page, "README.md")).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles([path.join(dir, "picked.txt"), path.join(dir, "notes.txt")]);

  const uploads = page.getByRole("region", { name: "Uploads" });
  await expect(uploads).toContainText("1 file already there");
  await uploads.getByRole("button", { name: "Keep both" }).click();
  await expect(uploads).toContainText(/Uploaded 2 files/);
  await expect(row(page, "picked.txt")).toBeVisible();
  await expect(row(page, "notes (2).txt")).toBeVisible();
  expect(fs.readFileSync(path.join(project, "notes (2).txt"), "utf8")).toBe("replacement");
  expect(fs.readFileSync(path.join(project, "notes.txt"), "utf8")).toBe("line one\nline two\n");
  await uploads.getByRole("button", { name: "Dismiss uploads" }).click();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file is renamed in place with F2", async ({ page }) => {
  await page.goto(filesRoute(project));
  await row(page, "picked.txt").click();
  await page.keyboard.press("F2");
  const field = page.getByLabel("Rename picked.txt");
  await expect(field).toBeFocused();
  // Only the name is selected, not the extension.
  await page.keyboard.type("renamed");
  await page.keyboard.press("Enter");
  await expect(row(page, "renamed.txt")).toBeVisible();
  expect(fs.existsSync(path.join(project, "renamed.txt"))).toBe(true);
  expect(fs.existsSync(path.join(project, "picked.txt"))).toBe(false);
});

test("with the list focused, letters jump, and ? and g-sequences still reach the shell", async ({ page }) => {
  await page.goto(filesRoute(project));
  await row(page, "README.md").click();
  // Type to jump.
  await page.keyboard.type("notes.");
  await expect(row(page, "notes.txt")).toHaveAttribute("aria-selected", "true");
  // ? opens the keymap sheet rather than being typed into the list.
  await page.keyboard.press("Shift+Slash");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // g then h goes Home.
  await row(page, "notes.txt").click();
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page).toHaveURL(/\/$/);
});

test("a place outside the workspace says so, with no Retry that cannot help", async ({ page }) => {
  await page.goto("/files/etc");
  const files = page.locator('section.surface[data-surface="files"]');
  await expect(files.getByText("Files can't go there.")).toBeVisible();
  await expect(files.getByRole("button", { name: "Go to the workspace" })).toBeVisible();
  await expect(files.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("a filter over a big folder says it only looks through what is loaded", async ({ page }) => {
  const big = path.join(project, "big");
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, "0")}.txt`), "");
  await page.goto(filesRoute(big));
  await expect(row(page, "f0000.txt")).toBeVisible();
  const files = page.locator('section.surface[data-surface="files"]');
  // Matches among the first page: the count says what it counted.
  await page.getByPlaceholder(/Filter/).fill("f00");
  await expect(files.locator(".files-status")).toContainText("100 matching in the 1,000 loaded, of 1,200 items");
  // A name past what is loaded: the list reads on until it finds it.
  await page.getByPlaceholder(/Filter/).fill("f1150");
  await expect(row(page, "f1150.txt")).toBeVisible();
  await expect(files.locator(".files-status")).toContainText("1 of 1,200 items");
  fs.rmSync(big, { recursive: true, force: true });
});

test("a folder downloads as a zip", async ({ page }) => {
  await page.goto(filesRoute(project));
  await row(page, "docs").click({ button: "right" });
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download as zip" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("docs.zip");
  const saved = await file.path();
  const head = fs.readFileSync(saved!).subarray(0, 2).toString("latin1");
  expect(head).toBe("PK");
});

test("things go to the trash, come back with Undo, and come back from the trash", async ({ page }) => {
  await page.goto(filesRoute(project));
  await row(page, "renamed.txt").click();
  await page.keyboard.press("Delete");
  await expect(page.getByText("Moved renamed.txt to the trash.")).toBeVisible();
  await expect(row(page, "renamed.txt")).toBeHidden();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "renamed.txt")).toBeVisible();

  // Two at once, then restored from the Trash view.
  await row(page, "renamed.txt").click();
  await row(page, "notes (2).txt").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("2 items selected");
  await page.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Move to trash" }).click();
  await expect(row(page, "renamed.txt")).toBeHidden();
  await expect(row(page, "notes (2).txt")).toBeHidden();

  await page.getByRole("button", { name: /^Trash/ }).click();
  await expect(page).toHaveURL(/\/files\?trash=1$/);
  const item = page.getByRole("row", { name: /renamed\.txt/ });
  await item.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored 1 item.")).toBeVisible();
  expect(fs.existsSync(path.join(project, "renamed.txt"))).toBe(true);
});

test("quick look walks the folder's files with the arrow keys", async ({ page }) => {
  await page.goto(filesRoute(project));
  await row(page, "notes.txt").click();
  await page.keyboard.press("Space");
  const look = page.getByRole("dialog", { name: /Quick look: notes\.txt/ });
  await expect(look).toContainText("line two");
  // Files sort by name, folders first: after notes.txt comes README.md.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: /Quick look: README\.md/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Quick look/ })).toBeHidden();
});

test("quick look shows pictures, frames a PDF without a sandbox attribute, and shows HTML as source", async ({ page }) => {
  const { png } = (await import("./tools/seed.mjs")) as { png(w: number, h: number): Buffer };
  fs.writeFileSync(path.join(project, "pixel.png"), png(8, 8));
  fs.writeFileSync(
    path.join(project, "tiny.pdf"),
    "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
  fs.writeFileSync(path.join(project, "page.html"), "<script>window.parent.pwned = 1</script><h1>hi</h1>");

  await page.goto(filesRoute(path.join(project, "pixel.png")));
  const img = page.getByRole("dialog", { name: /Quick look: pixel\.png/ }).getByRole("img", { name: "pixel.png" });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(8);

  await page.goto(filesRoute(path.join(project, "tiny.pdf")));
  const frame = page.getByRole("dialog", { name: /Quick look: tiny\.pdf/ }).locator("iframe");
  await expect(frame).toHaveAttribute("src", /inline=1/);
  // Chromium refuses a PDF in a frame with a sandbox attribute; the response's
  // own CSP: sandbox isolates it.
  expect(await frame.getAttribute("sandbox")).toBeNull();

  await page.goto(filesRoute(path.join(project, "page.html")));
  const look = page.getByRole("dialog", { name: /Quick look: page\.html/ });
  await expect(look).toContainText("<script>window.parent.pwned = 1</script>");
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});
