import type { Browser, Cookie, Page } from "@playwright/test";
import { signIn } from "./gate.ts";

/**
 * Sign in once for a whole spec file and hand the session to every test.
 * The gate allows thirty sign-in attempts a minute across all clients, and a
 * suite that signed in for every test would spend them; the journeys that
 * are about signing in still do it for real.
 */
export async function sharedSession(browser: Browser, clientIp: string): Promise<Cookie[]> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-agentbox-client-ip": clientIp } });
  const page = await context.newPage();
  await signIn(page);
  const cookies = await context.cookies();
  await context.close();
  return cookies;
}

/** Put a shared session into this test's browser and open `path`. */
export async function resume(page: Page, cookies: Cookie[], path = "/"): Promise<void> {
  await page.context().addCookies(cookies);
  await page.goto(path);
}
