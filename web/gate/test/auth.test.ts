import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABSOLUTE_MS, Auth, IDLE_MS, type Ended } from "../src/auth.js";
import { Store } from "../src/store.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-auth-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ending credentials", () => {
  it("announces each session and token that ends, so what it opened can be cut", async () => {
    let t = 1_000_000;
    const store = await Store.open(dir, null);
    const auth = new Auth(store, () => t);
    const heard: Ended[] = [];
    auth.onEnded((e) => heard.push(...e));

    const a = await auth.createSession({ remember: false, ip: "1", userAgent: "" });
    const b = await auth.createSession({ remember: true, ip: "1", userAgent: "" });
    const c = await auth.createSession({ remember: true, ip: "1", userAgent: "" });
    await auth.endSession(a.session.id);
    expect(heard).toEqual([{ kind: "session", id: a.session.id }]);
    await auth.endSessions(b.session.id);
    expect(heard.at(-1)).toEqual({ kind: "session", id: c.session.id });

    const tok = await auth.createToken("x");
    await auth.revokeToken(tok.record.id);
    expect(heard.at(-1)).toEqual({ kind: "token", id: tok.record.id });

    // Idle is not ended: a session that stopped making requests may still be
    // holding a live terminal, and it can open nothing new.
    const idle = await auth.createSession({ remember: false, ip: "1", userAgent: "" });
    t += IDLE_MS + 1;
    const count = heard.length;
    await auth.prune();
    expect(heard.length).toBe(count);
    expect(store.data.sessions.some((s) => s.id === idle.session.id)).toBe(false);

    // Past the absolute end, it is.
    t += ABSOLUTE_MS;
    await auth.prune();
    expect(heard.at(-1)).toEqual({ kind: "session", id: b.session.id });
  });
});
