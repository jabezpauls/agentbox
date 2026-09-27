import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GATE, signIn } from "./gate.ts";

/**
 * A service worker registered by a page the sandbox serves would control every
 * page in its scope — the sign-in page included — for good. The gate refuses
 * the worker's script outside the editor. This registers one the way an
 * agent's page would: top level, same origin, from a server started in the
 * sandbox and reached through the bridge.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let server: ChildProcess | null = null;
let port = 0;
let dir = "";

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-sw-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><title>sw-pending</title><script>
      navigator.serviceWorker.register("sw.js", { scope: "./" }).then(
        () => navigator.serviceWorker.ready.then(() => { document.title = "sw-registered"; }),
        (e) => { document.title = "sw-refused: " + e.message; },
      );
    </script>`,
  );
  fs.writeFileSync(
    path.join(dir, "sw.js"),
    `self.addEventListener("fetch", (e) => e.respondWith(new Response("<h1>taken over</h1>", { headers: { "content-type": "text/html" } })));`,
  );
  port = await freePort();
  server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: dir, stdio: "ignore" });
  // Wait until it answers.
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the sign-in page clears workers left from before, and keeps the editor's", async ({ page, context }) => {
  // Stand in for the old layout: before the gate, code-server was served at /
  // and its worker was registered at the root scope. The gate now refuses such
  // a script, so the browser is handed it by the test's own router instead.
  const worker = `self.addEventListener("fetch", () => {});`;
  for (const p of ["/old-root-sw.js", "/workbench/old-sw.js", "/vscode/sw.js"]) {
    await context.route(`${GATE}${p}`, (route) => route.fulfill({ contentType: "text/javascript", body: worker }));
  }
  await page.goto(`${GATE}/login`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/old-root-sw.js", { scope: "/" });
    await navigator.serviceWorker.register("/workbench/old-sw.js", { scope: "/workbench/" });
    await navigator.serviceWorker.register("/vscode/sw.js", { scope: "/vscode/" });
  });
  const scopes = () =>
    page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort());
  expect(await scopes()).toEqual(["/", "/vscode/", "/workbench/"]);

  // The next visit to the sign-in page clears all but the editor's.
  await page.goto(`${GATE}/login`);
  await expect.poll(scopes).toEqual(["/vscode/"]);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a page from the sandbox cannot register a service worker", async ({ page }) => {
  await signIn(page);
  const scriptStatus: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/sw.js")) scriptStatus.push(r.status());
  });
  await page.goto(`${GATE}/workbench/preview/${port}/index.html`);
  await expect(page).toHaveTitle(/^sw-refused/, { timeout: 15_000 });
  // Refused by the gate, for being a worker's script: the same file loads fine
  // as an ordinary script.
  expect(await page.title()).toContain("403");
  const plain = await page.evaluate(async () => (await fetch("sw.js")).status);
  expect(plain).toBe(200);
  // And nothing took over: signed out, the sign-in page is still the gate's.
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(registrations).toBe(0);
  expect(await page.evaluate(async () => (await fetch("/_gate/logout", { method: "POST" })).status)).toBe(204);
  await page.goto(`${GATE}/login`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
