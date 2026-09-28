import fs from "node:fs";
import path from "node:path";
import { devices, expect, test, type Cookie, type Page } from "@playwright/test";
import { resume, sharedSession } from "./session.ts";

/**
 * J7 — from a phone: the same app with a bottom bar instead of the rail,
 * More for the rest, and agents, apps and files usable one-handed.
 */

test.use({ ...devices["Pixel 7"] });
test.describe.configure({ mode: "serial" });

let cookies: Cookie[] = [];
test.beforeAll(async ({ browser }) => {
  cookies = await sharedSession(browser, "203.0.113.200");
});
test.beforeEach(async ({ page }) => {
  await resume(page, cookies);
  await expect(page.locator('section.surface[data-surface="home"][data-active]')).toBeVisible();
});

const surface = (page: Page, id: string) => page.locator(`section.surface[data-surface="${id}"][data-active]`);
const bottomBar = (page: Page) => page.locator("nav.bottombar");

test("the bottom bar replaces the rail, and More holds the rest", async ({ page }) => {
  await expect(page.locator("nav.rail")).toBeHidden();
  await expect(bottomBar(page)).toBeVisible();
  for (const name of ["Home", "Workbench", "Files", "Apps", "More"]) {
    await expect(bottomBar(page).getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }

  await bottomBar(page).getByRole("button", { name: /^Apps/ }).tap();
  await expect(surface(page, "apps")).toBeVisible();

  await bottomBar(page).getByRole("button", { name: /^More/ }).tap();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "System" }).tap();
  await expect(sheet).toBeHidden();
  await expect(surface(page, "system")).toBeVisible();
  // The bar says where you are when that is one of More's.
  await expect(bottomBar(page).getByRole("button", { name: /^System/ })).toBeVisible();

  await bottomBar(page).getByRole("button", { name: /^System/ }).tap();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).tap();
  await expect(surface(page, "settings")).toBeVisible();
});

test("the dock is a full-screen sheet on a phone, and closes back to where you were", async ({ page }) => {
  await bottomBar(page).getByRole("button", { name: /^More/ }).tap();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Dock" }).tap();
  const dock = page.getByRole("dialog", { name: "Dock" });
  await expect(dock).toBeVisible();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBe(page.viewportSize()!.width);
  await dock.getByRole("button", { name: "Close the dock" }).tap();
  await expect(dock).toBeHidden();
  await expect(surface(page, "home")).toBeVisible();
});

test("files: a tap opens a folder, another looks at a file, and the palette is a whole screen", async ({ page }) => {
  const root = await page.evaluate(async () => ((await (await fetch("/api/health")).json()) as { workspaceRoot: string }).workspaceRoot);
  fs.mkdirSync(path.join(root, "phone", "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "phone", "notes", "todo.md"), "# To do\n\n- one-handed\n");

  await bottomBar(page).getByRole("button", { name: /^Files/ }).tap();
  await expect(surface(page, "files")).toBeVisible();
  await page.getByRole("row", { name: "phone", exact: true }).tap();
  await page.getByRole("row", { name: "notes", exact: true }).tap();
  await page.getByRole("row", { name: "todo.md", exact: true }).tap();
  const look = page.getByRole("dialog", { name: /Quick look: todo\.md/ });
  await expect(look.getByRole("heading", { name: "To do" })).toBeVisible();
  // Measured once its entrance has settled.
  await expect.poll(async () => Math.round((await look.boundingBox())?.width ?? 0)).toBe(page.viewportSize()!.width);
  await look.getByRole("button", { name: "Close" }).tap();
  await expect(look).toBeHidden();

  // Search from More: the palette fills the screen.
  await bottomBar(page).getByRole("button", { name: /^More/ }).tap();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Search everything" }).tap();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect.poll(async () => Math.round((await palette.boundingBox())?.width ?? 0)).toBe(page.viewportSize()!.width);
  await page.getByLabel("Command palette query").fill("todo");
  await expect(palette.getByRole("option", { name: /todo\.md/ })).toBeVisible();
});

test("the Workbench's sidebar is a sheet, and agents are one tap away", async ({ page }) => {
  await bottomBar(page).getByRole("button", { name: /^Workbench/ }).tap();
  await expect(surface(page, "workbench")).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).tap();
  const sidebar = page.locator(".wb .sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("heading", { name: "Workbench" })).toBeVisible();
  await page.getByRole("button", { name: "Hide sidebar" }).tap();
});
