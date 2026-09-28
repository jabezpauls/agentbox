#!/usr/bin/env node
// Look at the running app: sign in through the gate and screenshot a route.
//
//   node e2e/tools/shoot.mjs <base> <route> <out.png> [light|dark] [WxH] [script.js]
//
// `script.js`, when given, is evaluated in the page after it settles (open a
// menu, type into something) before the picture is taken. A development aid
// for working on the UI; the docs' screenshots come from e2e/screenshots.spec.ts.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const [base, route = "/", out = "shot.png", scheme = "light", size = "1440x900", scriptPath] = process.argv.slice(2);
if (!base) {
  console.error("usage: shoot.mjs <base> <route> <out.png> [light|dark] [WxH] [script.js]");
  process.exit(2);
}
const [width, height] = size.split("x").map(Number);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height },
  colorScheme: scheme === "dark" ? "dark" : "light",
  deviceScaleFactor: 1,
  extraHTTPHeaders: { "x-agentbox-client-ip": "203.0.113.250" },
});
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("response", (r) => r.status() >= 400 && console.error("http:", r.status(), r.request().method(), r.url()));
await page.goto(`${base}/login?next=${encodeURIComponent(route)}`);
await page.getByLabel("Username").fill(process.env.E2E_USER ?? "e2e");
await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
await page.waitForTimeout(1200);
if (scriptPath) {
  const code = fs.readFileSync(scriptPath, "utf8");
  await page.evaluate(code);
  await page.waitForTimeout(600);
}
await page.screenshot({ path: out });
await browser.close();
console.log(out);
