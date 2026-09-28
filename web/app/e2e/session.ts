import type { Browser, Cookie, Page } from "@playwright/test";
import { clientIp, signIn } from "./gate.ts";

/**
 * Sign in once for a whole spec file and hand the session to every test, as a
 * client address of its own. Signing in costs a bcrypt check and a share of
 * the gate's budget, and most specs are not about signing in; the journeys
 * that are still do it for real.
 */
export async function sharedSession(browser: Browser): Promise<Cookie[]> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-agentbox-client-ip": clientIp() } });
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
