import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { machinesApi } from "./api.ts";
import { forgetPassphrase, heldPassphrase, holdPassphrase, presenceAnswer } from "./presence.ts";

describe("presence in the browser", () => {
  it("answers exactly what the machine computes", async () => {
    // Generated per run: never a real passphrase.
    const pass = `p-${randomBytes(8).toString("hex")}`;
    const salt = randomBytes(16);
    const challenge = randomBytes(32);
    const session = "a".repeat(24);
    const machine = "b".repeat(24);
    const iterations = 1000;
    const got = await presenceAnswer(pass, { challenge: challenge.toString("base64url"), salt: salt.toString("base64url"), iterations, session, machine });
    const key = pbkdf2Sync(pass, salt, iterations, 32, "sha256");
    const want = createHmac("sha256", key).update(Buffer.concat([challenge, Buffer.from(session + machine)])).digest("base64url");
    expect(got).toBe(want);
  });

  it("holds the passphrase in this tab only", () => {
    holdPassphrase("held for the tab");
    expect(heldPassphrase()).toBe("held for the tab");
    expect(sessionStorage.getItem("agentbox.machines.passphrase")).toBe("held for the tab");
    expect(localStorage.length).toBe(0);
    forgetPassphrase();
    expect(heldPassphrase()).toBeNull();
  });

  it("forgets the passphrase on signing out", async () => {
    holdPassphrase("held until sign-out");
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await machinesApi.signOut();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(heldPassphrase()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
