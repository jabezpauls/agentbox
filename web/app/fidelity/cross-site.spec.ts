import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { BASE, TINY_APPS, WORKSPACES, api, freePort, makeApp, signIn, startServer, stopServers, test, waitPort } from "./helpers.ts";

/**
 * Another site that knows a private app's id, visited by the owner.
 *
 * The app's grant is `SameSite=None` — an app's own page is an opaque origin,
 * so everything it asks for is cross-site — and nothing the browser sends
 * tells the app's own page apart from another site's sandboxed frame (both
 * `Origin: null`, `Sec-Fetch-Site: cross-site`, no referrer). `Partitioned`
 * would keep the grant to the box as the top-level site, but no engine can
 * use it here: Chromium and Firefox key the app's own requests (from an
 * opaque document) to a partition other than the one its page load set the
 * grant in, so the app stops working, and WebKit ignores it. So the grant is
 * bounded instead: it exists only while the owner has the app open (an hour
 * unused), dies with the owner's session, and opens one app. These tests
 * prove the bounds; the last documents the limit (docs/security.md).
 */

test.describe.configure({ mode: "serial" });

let evil: http.Server;
let evilOrigin = "";
let appId = "";
let otherId = "";

test.beforeAll(async () => {
  evil = http.createServer((req, res) => {
    const target = decodeURIComponent(new URL(req.url ?? "/", "http://x").searchParams.get("target") ?? "");
    res.writeHead(200, { "content-type": "text/html" });
    // A frame of the other site's own, sandboxed so its requests say
    // `Origin: null` as the app's own page does, reads the app and posts to
    // it, with credentials.
    const inner = `<script>
      Promise.all([
        fetch(${JSON.stringify(target)} + "secret", { credentials: "include" }).then((r) => r.ok ? r.text().then((t) => "READ " + t.slice(0, 40)) : "REFUSED " + r.status),
        fetch(${JSON.stringify(target)} + "write", { method: "POST", credentials: "include", body: "x" }).then((r) => "POSTED " + r.status),
      ]).then((a) => parent.postMessage(a.join(" | "), "*"), (e) => parent.postMessage("FAILED " + e, "*"));
    <\/script>`;
    res.end(`<iframe sandbox="allow-scripts" srcdoc="${inner.replace(/"/g, "&quot;")}"></iframe>
      <script>addEventListener("message", (e) => { document.title = e.data; });<\/script>`);
  });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
  evilOrigin = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  stopServers();
  await new Promise<void>((r) => evil.close(() => r()));
});

/** What the other site's frame managed against `id`. */
async function fromEvil(page: Page, id: string): Promise<string> {
  await page.goto(`${evilOrigin}/?target=${encodeURIComponent(`${BASE}/a/${id}/`)}`);
  await expect.poll(() => page.title(), { timeout: 15_000 }).not.toBe("");
  return page.title();
}

function nothing(outcome: string): void {
  expect(outcome).not.toContain("READ");
  expect(outcome).not.toContain("POSTED 200");
}

test("another site gets nothing of a private app the owner has not opened, nor of another app", async ({ page }) => {
  await signIn(page);
  const name = test.info().project.name;
  const dir = path.join(WORKSPACES, `cross-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const which of ["a", "b"]) {
    const port = await freePort();
    startServer(process.execPath, [TINY_APPS, "login"], dir, { PORT: String(port) });
    await waitPort(port);
    const id = await makeApp(page, port, `cross-${which}-${name}`);
    if (which === "a") appId = id;
    else otherId = id;
  }
  // Signed in to the box, but the app never opened: no grant.
  nothing(await fromEvil(page, appId));
  // The owner opens the other app: its grant opens that app alone.
  await page.goto(`${BASE}/a/${otherId}/`);
  await expect(page.getByRole("heading", { name: "Please sign in" })).toBeVisible();
  nothing(await fromEvil(page, appId));
});

test("another site gets nothing once the owner has signed out", async ({ browser }) => {
  // A context of its own, so signing out does not end the suite's session.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login?next=${encodeURIComponent(`/a/${appId}/`)}`);
  await page.getByLabel("Username").fill(process.env.E2E_USER ?? "e2e");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Please sign in" })).toBeVisible();
  await page.goto(`${BASE}/workbench`);
  expect((await api(page, "POST", "/_gate/logout")).status).toBe(204);
  // The open app sees its session end and goes to /login by itself, which
  // would race the next page load: the other site opens in a tab of its own.
  await page.close();
  nothing(await fromEvil(await ctx.newPage(), appId));
  await ctx.close();
});

test("the limit: while the owner has the app open, another site's frame rides its grant", async ({ page }) => {
  // Expected to fail in every engine: nothing a browser sends tells an
  // opaque page of another site from the app's own. If this starts passing,
  // an engine has begun to tell them apart; update docs/security.md.
  test.fail();
  await signIn(page);
  await page.goto(`${BASE}/a/${appId}/`);
  await expect(page.getByRole("heading", { name: "Please sign in" })).toBeVisible();
  nothing(await fromEvil(page, appId));
});
