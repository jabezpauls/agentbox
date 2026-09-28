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
  // The suite spends most of the gate's sign-in budget for all clients (some
  // specs must sign in for real); a sign-in the gate turns away as busy waits
  // out the pause it names and goes again.
  for (let attempt = 0; ; attempt++) {
    try {
      await signIn(page);
      break;
    } catch (err) {
      const said = (await page.locator("[role=alert], .login-error").first().textContent().catch(() => "")) ?? "";
      const wait = Number(/(\d+) seconds?/.exec(said)?.[1] ?? 0);
      if (attempt >= 3 || !wait) throw err;
      await page.waitForTimeout((wait + 1) * 1000);
    }
  }
  const cookies = await context.cookies();
  await context.close();
  return cookies;
}

/** Put a shared session into this test's browser and open `path`. */
export async function resume(page: Page, cookies: Cookie[], path = "/"): Promise<void> {
  await page.context().addCookies(cookies);
  await page.goto(path);
}
