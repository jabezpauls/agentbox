import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/** The login e2e/start-stack.mjs seeds the gate with. */
export const USER = process.env.E2E_USER ?? "e2e";
export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-1";
export const GATE = `http://127.0.0.1:${process.env.GATE_PORT ?? 7900}`;

// Where the next client address starts: random, so a suite repeated on one
// stack (`--repeat-each`, or a worker restarted after a failure) never meets
// the failures, pauses or lockouts an earlier run left on an address.
let nextClient = Math.floor(Math.random() * 0x10000);

/**
 * An address no other test in this stack's life has used, for the header the
 * harness trusts in place of a proxy's (`x-agentbox-client-ip`): each test is
 * its own client, with its own sign-in budget. From 198.18.0.0/15, a range
 * reserved for testing.
 */
export function clientIp(): string {
  const n = nextClient++ % 0x20000;
  return `198.${18 + (n >> 16)}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

/**
 * Sign in through the real page, and land where `next` points — as a client
 * address of its own, so no earlier test's attempts count against it.
 */
export async function signIn(page: Page, next = "/"): Promise<void> {
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": clientIp() });
  await page.goto(`${GATE}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${GATE}${next}`);
}

/**
 * Call the gate's API from inside the page, as the app does: the browser
 * attaches the session cookie and the Origin itself. (Playwright's own request
 * client will not send a Secure cookie over plain http, even to loopback.)
 */
export async function gateApi(
  page: Page,
  method: "POST" | "DELETE",
  path: string,
  data?: object,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ method, path, data }) => {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(data ?? {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    },
    { method, path, data },
  );
}

/** Make an app of a port, as the owner does from the Preview panel; returns its id. */
export async function makeApp(page: Page, port: number, name?: string): Promise<string> {
  const res = await gateApi(page, "POST", "/_gate/apps", { port, ...(name ? { name } : {}) });
  if (res.status !== 201) throw new Error(`could not make an app of :${port}: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body.id);
}

function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The code an authenticator app would show, `stepsAhead` periods from now —
 * the gate accepts one period of drift, and a code is good only once.
 */
export function totp(secret: string, stepsAhead = 0): string {
  const counter = Math.floor(Date.now() / 30_000) + stepsAhead;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
