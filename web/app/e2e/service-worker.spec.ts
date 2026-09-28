import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GATE, makeApp, signIn } from "./gate.ts";

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
      try {
        navigator.serviceWorker.register("sw.js", { scope: "./" }).then(
          () => navigator.serviceWorker.ready.then(() => { document.title = "sw-registered"; }),
          (e) => { document.title = "sw-refused: " + e.name; },
        );
      } catch (e) {
        document.title = "sw-refused: " + e.name;
      }
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

test("code-server's own worker registers under /vscode/, and no higher", async ({ page }) => {
  // A stand-in for code-server on the port the gate forwards /vscode/ to: its
  // worker script asks for the whole of its root, as code-server's does.
  const codePort = Number(process.env.E2E_CODE_PORT ?? 7808);
  const editor = http.createServer((req, res) => {
    if (req.url?.startsWith("/_static/out/browser/serviceWorker.js")) {
      res.writeHead(200, { "content-type": "text/javascript", "service-worker-allowed": "/" });
      res.end(`self.addEventListener("fetch", () => {});`);
      return;
    }
    // A compromised editor asking for more than its root, with a dot segment
    // the browser would resolve after the gate had prefixed it.
    if (req.url?.startsWith("/_static/out/browser/climb.js")) {
      res.writeHead(200, { "content-type": "text/javascript", "service-worker-allowed": "/%2e%2e/" });
      res.end(`self.addEventListener("fetch", () => {});`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>editor</title>");
  });
  await new Promise<void>((r) => editor.listen(codePort, "127.0.0.1", r));
  try {
    await signIn(page, "/vscode/");
    const outcome = await page.evaluate(async () => {
      const script = "_static/out/browser/serviceWorker.js";
      const own = await navigator.serviceWorker.register(script, { scope: "./" }).then(
        (r) => new URL(r.scope).pathname,
        (e: Error) => `refused: ${e.message}`,
      );
      const root = await navigator.serviceWorker.register(script, { scope: "/" }).then(
        (r) => new URL(r.scope).pathname,
        (e: Error) => `refused: ${e.name}`,
      );
      const climb = await navigator.serviceWorker.register("_static/out/browser/climb.js", { scope: "/" }).then(
        (r) => new URL(r.scope).pathname,
        (e: Error) => `refused: ${e.name}`,
      );
      return { own, root, climb };
    });
    // Its own root is the editor's prefix: allowed, as code-server needs.
    expect(outcome.own).toBe("/vscode/");
    // The box's root is not: the gate rewrote "/" to "/vscode/", never passed it.
    expect(outcome.root).toBe("refused: SecurityError");
    // Nor can a Service-Worker-Allowed that would climb out of /vscode/.
    expect(outcome.climb).toBe("refused: SecurityError");
    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    });
  } finally {
    await new Promise<void>((r) => editor.close(() => r()));
  }
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

test("an app's page cannot register a service worker", async ({ page }) => {
  await signIn(page);
  const id = await makeApp(page, port, "sw-test");
  // Opened full screen, as its own top-level page: it runs with an opaque
  // origin all the same (the gate's CSP sandbox), which has no workers at all
  // — and the gate refuses a worker's script outside the editor besides.
  await page.goto(`${GATE}/a/${id}/index.html`);
  await expect(page).toHaveTitle(/^sw-refused/, { timeout: 15_000 });
  expect(await page.evaluate(() => window.origin)).toBe("null");
  // The same file loads as an ordinary script, on the page's grant.
  const plain = await page.evaluate(async () => (await fetch("sw.js")).status);
  expect(plain).toBe(200);
  // And nothing took over the box: no worker on its origin, and signed out,
  // the sign-in page is still the gate's.
  await page.goto(`${GATE}/workbench`);
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(registrations).toBe(0);
  expect(await page.evaluate(async () => (await fetch("/_gate/logout", { method: "POST" })).status)).toBe(204);
  await page.goto(`${GATE}/login`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
