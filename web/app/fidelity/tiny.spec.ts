import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  BASE,
  TINY_APPS,
  WORKSPACES,
  api,
  freePort,
  makeApp,
  pickApp,
  previewFrame,
  signIn,
  startServer,
  stopServers,
  visitor,
  waitPort,
  test,
} from "./helpers.ts";

/**
 * Small apps written for `/`, as most are: one that uses browser storage, and
 * one with its own cookie sign-in and a live event stream. Under /a/<id>/
 * they run with an opaque origin, so browser storage is the shim's in-memory
 * stand-in, and the app's own cookies are the gate's rewrite of them.
 */

test.describe.configure({ mode: "serial" });

let tag = "";
let dir = "";

test.beforeAll(async ({}, testInfo) => {
  tag = testInfo.project.name;
  // Under the workspace root, so the servers count as the owner's.
  dir = path.join(WORKSPACES, `tiny-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
});

test.afterAll(() => stopServers());

async function tinyApp(page: Page, mode: "storage" | "login" | "sprite", name: string): Promise<{ id: string; port: number }> {
  const port = await freePort();
  startServer(process.execPath, [TINY_APPS, mode], dir, { PORT: String(port) });
  await waitPort(port);
  return { id: await makeApp(page, port, name), port };
}

test("an app using localStorage and document.cookie runs, in the panel and full screen", async ({ page }) => {
  await signIn(page);
  await tinyApp(page, "storage", `storage-${tag}`);
  await pickApp(page, `storage-${tag}`);
  await expect(previewFrame(page).locator("#result")).toHaveText("storage ok v w c=1");
  await page.goto(`${BASE}/a/${await appId(page, `storage-${tag}`)}/`);
  await expect(page.locator("#result")).toHaveText("storage ok v w c=1");
});

test("icons from an SVG sprite in another file show, in the panel and full screen", async ({ page }) => {
  // An opaque page may not <use> a sprite from another file (to it, another
  // origin); the shim puts the sprite in the page instead.
  const drawn = (scope: { locator: Page["locator"] }) =>
    Promise.all(["#static", "#scripted"].map((sel) => scope.locator(sel).evaluate((el) => (el as SVGGraphicsElement).getBBox().width)));
  await signIn(page);
  await tinyApp(page, "sprite", `sprite-${tag}`);
  await pickApp(page, `sprite-${tag}`);
  await expect.poll(() => drawn(previewFrame(page))).toEqual([16, 16]);
  await page.goto(`${BASE}/a/${await appId(page, `sprite-${tag}`)}/`);
  await expect.poll(() => drawn(page)).toEqual([16, 16]);
});

async function appId(page: Page, name: string): Promise<string> {
  const { body } = await api(page, "GET", "/_gate/apps");
  const app = (body.apps as Array<{ id: string; name: string }>).find((a) => a.name === name);
  if (!app) throw new Error(`no app ${name}`);
  return app.id;
}

test("an app's own cookie sign-in works private, and shared with a visitor; stopping sharing cuts the visitor's stream", async ({ page, browser }) => {
  await signIn(page);
  const { id } = await tinyApp(page, "login", `login-${tag}`);

  // Private, in the panel.
  await pickApp(page, `login-${tag}`);
  const frame = previewFrame(page);
  await frame.getByRole("button", { name: "Sign in" }).click();
  await expect(frame.locator("#who")).toHaveText("Signed in as ada");
  await expect(frame.locator("#stream")).toHaveText("streaming");
  await expect.poll(async () => Number(await frame.locator("#tick").textContent())).toBeGreaterThan(1);

  // Shared with the link: a visitor signs in to the app, and streams.
  expect((await api(page, "PUT", `/_gate/apps/${id}/visibility`, { mode: "link", expiresIn: 3600 })).status).toBe(200);
  const ctx = await visitor(browser);
  const guest = await ctx.newPage();
  await guest.goto(`${BASE}/a/${id}/`);
  await guest.getByRole("button", { name: "Sign in" }).click();
  await expect(guest.locator("#who")).toHaveText("Signed in as ada");
  await expect(guest.locator("#stream")).toHaveText("streaming");
  await expect.poll(async () => Number(await guest.locator("#tick").textContent())).toBeGreaterThan(1);

  // Stop sharing: the visitor's open stream is cut at once, and it cannot
  // come back.
  expect((await api(page, "DELETE", `/_gate/apps/${id}/visibility`)).status).toBe(200);
  await expect(guest.locator("#stream")).toHaveText("stream lost", { timeout: 10_000 });
  await guest.reload();
  await expect(guest).toHaveURL(/\/login\?next=/);
  // The owner's own stream in the panel carries on.
  const before = Number(await frame.locator("#tick").textContent());
  await expect.poll(async () => Number(await frame.locator("#tick").textContent())).toBeGreaterThan(before);
  await ctx.close();
});

test("a passcode lets a visitor in, and a wrong one does not", async ({ page, browser }) => {
  await signIn(page);
  await tinyApp(page, "login", `passcode-${tag}`);
  await pickApp(page, `passcode-${tag}`);
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByText("Link and a passcode").click();
  await expect(page.getByRole("radio", { name: "Link and a passcode" })).toBeChecked();
  await page.getByRole("textbox", { name: "Passcode" }).fill("open sesame");
  await page.getByRole("button", { name: "Share and copy link" }).click();
  await expect(page.getByText(/Shared with a passcode/).first()).toBeVisible();
  const link = await page.getByRole("textbox", { name: "Link", exact: true }).inputValue();

  const ctx = await visitor(browser);
  const guest = await ctx.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: `passcode-${tag}` })).toBeVisible();
  await guest.getByRole("textbox", { name: "Passcode" }).fill("wrong one");
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByRole("alert")).toContainText("isn’t right");
  await guest.getByRole("textbox", { name: "Passcode" }).fill("open sesame");
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByRole("heading", { name: "Please sign in" })).toBeVisible();
  await guest.getByRole("button", { name: "Sign in" }).click();
  await expect(guest.locator("#who")).toHaveText("Signed in as ada");
  await ctx.close();
});

test("a link that expires stops opening", async ({ page, browser }) => {
  await signIn(page);
  const { id } = await tinyApp(page, "login", `expiry-${tag}`);
  expect((await api(page, "PUT", `/_gate/apps/${id}/visibility`, { mode: "link", expiresIn: 3 })).status).toBe(200);
  const ctx = await visitor(browser);
  const guest = await ctx.newPage();
  await guest.goto(`${BASE}/a/${id}/`);
  await expect(guest.getByRole("heading", { name: "Please sign in" })).toBeVisible();
  await guest.waitForTimeout(3_500);
  await guest.reload();
  await expect(guest).toHaveURL(/\/login\?next=/);
  await ctx.close();
});
