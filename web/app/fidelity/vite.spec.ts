import fs from "node:fs";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import {
  BASE,
  copyVite,
  freePort,
  idFrom,
  pickApp,
  preview,
  previewFrame,
  showPreview,
  signIn,
  startServer,
  stopServers,
  visitor,
  waitPort,
  test,
} from "./helpers.ts";

/**
 * A real create-vite React-TS dev server under /a/<id>/, two ways:
 *
 * (a) started by agentbox-preview, as an agent would — Vite is given its base
 *     path, so it serves under the prefix natively;
 * (b) started plainly with `npm run dev`, as a person would — Vite thinks it
 *     runs at `/`, and the gate's path fixes (HTML rewrite, import map, shim)
 *     are what make it work.
 *
 * Both must render in the Preview panel, load the template's image, and apply
 * an edit live (HMR, with the component's state kept — a full reload would
 * lose it), privately and shared with a visitor who is not signed in.
 */

test.describe.configure({ mode: "serial" });

let dirA = "";
let dirB = "";
let idA = "";
let idB = "";
let portB = 0;
let tag = "";

test.beforeAll(async ({}, testInfo) => {
  tag = testInfo.project.name;
  dirA = copyVite(`vite-a-${tag}`);
  dirB = copyVite(`vite-b-${tag}`);
});

test.afterAll(async () => {
  if (idA) await preview(["stop", idA], dirA);
  stopServers();
});

/** What the template renders, and proof its image arrived. */
async function rendersTemplate(frame: FrameLocator): Promise<void> {
  await expect(frame.getByRole("heading", { level: 1 })).toHaveText("Get started", { timeout: 60_000 });
  await expect
    .poll(() => frame.locator("img.base").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

/** An edit reaches the page without a reload: the counter keeps its count. */
async function liveReloads(frame: FrameLocator, dir: string, to: string): Promise<void> {
  const counter = frame.getByRole("button", { name: /Count is/ });
  await counter.click();
  await counter.click();
  await expect(counter).toHaveText("Count is 2");
  const file = path.join(dir, "src", "App.tsx");
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, before.replace(/<h1>[^<]*<\/h1>/, `<h1>${to}</h1>`));
  await expect(frame.getByRole("heading", { level: 1 })).toHaveText(to, { timeout: 30_000 });
  await expect(counter).toHaveText("Count is 2");
}

async function openInPanel(page: Page): Promise<void> {
  await signIn(page);
}

test("(a) agentbox-preview start: it opens in the Preview of an open tab, renders, loads its image and live-reloads", async ({ page }) => {
  await openInPanel(page);
  const run = await preview(["start", "--name", `vite-a-${tag}`, "--timeout", "90", "--", "npm", "run", "dev"], dirA);
  expect(run.code, run.stderr).toBe(0);
  idA = idFrom(run);
  expect(run.stdout).toContain(`/a/${idA}/`);
  // Every open tab switches its Preview to the app, and says who asked.
  await expect(page.getByText(`agentbox-preview opened vite-a-${tag} in Preview`)).toBeVisible();
  // The panel checks the app before framing it, and a first page load waits
  // on Vite optimising its dependencies: slow on a busy machine.
  await expect(page.locator("iframe.prev-frame")).toHaveAttribute("src", `/a/${idA}/`, { timeout: 60_000 });
  const frame = previewFrame(page);
  await rendersTemplate(frame);
  await liveReloads(frame, dirA, "Edited live (a)");
});

test("(b) plain npm run dev: made an app from the panel, it renders, loads its image and live-reloads", async ({ page }) => {
  await openInPanel(page);
  portB = await freePort();
  // No base path and no --host: Vite believes it is at the root of localhost.
  startServer("npm", ["run", "dev", "--", "--port", String(portB), "--strictPort"], dirB);
  await waitPort(portB);
  await showPreview(page);
  await page.getByRole("list", { name: "Also listening" }).getByRole("button", { name: new RegExp(`:${portB}\\b`) }).click();
  await expect(page.locator("iframe.prev-frame")).toHaveAttribute("src", /^\/a\/[a-z2-7]{26}\/$/, { timeout: 60_000 });
  idB = String(await page.locator("iframe.prev-frame").getAttribute("src")).split("/")[2] as string;
  const frame = previewFrame(page);
  await rendersTemplate(frame);
  // The path fixes reached everything this page names: no hint.
  await expect(page.getByText(/This app assumes it runs at/)).toHaveCount(0);
  await liveReloads(frame, dirB, "Edited live (b)");
});

test("full screen, private: the owner's own tab of the app", async ({ page }) => {
  await signIn(page);
  for (const id of [idA, idB]) {
    await page.goto(`${BASE}/a/${id}/`);
    // The same sandbox as in the panel: an opaque origin.
    await expect.poll(() => page.evaluate(() => window.origin)).toBe("null");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Edited live", { timeout: 60_000 });
    await expect
      .poll(() => page.locator("img.base").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
  }
});

test("shared with the link: a visitor who is not signed in sees it live; stopping sharing ends it", async ({ page, browser }) => {
  await signIn(page);
  await pickApp(page, `:${portB}\\b`);
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Share and copy link" }).click();
  await expect(page.getByText(/anyone with the link can open it/i).first()).toBeVisible();
  const link = await page.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  expect(link).toBe(`${BASE}/a/${idB}/`);

  const ctx = await visitor(browser);
  const guest = await ctx.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { level: 1 })).toContainText("Edited live", { timeout: 60_000 });
  await expect
    .poll(() => guest.locator("img.base").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  // Live for the visitor too: HMR over the app's own WebSocket.
  const file = path.join(dirB, "src", "App.tsx");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/<h1>[^<]*<\/h1>/, "<h1>Shared live</h1>"));
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Shared live", { timeout: 30_000 });

  await page.getByRole("button", { name: /Stop sharing/ }).click();
  await expect(page.getByText(/anyone with the link can open it/i)).toHaveCount(0);
  // Private again: the visitor is sent to sign in.
  await guest.reload();
  await expect(guest).toHaveURL(/\/login\?next=/);
  await ctx.close();
});
