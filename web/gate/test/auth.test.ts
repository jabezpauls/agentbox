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

async function setup() {
  const clock = { t: 1_000_000 };
  const store = await Store.open(dir, null);
  const auth = new Auth(store, () => clock.t);
  const heard: Ended[] = [];
  auth.onEnded((e) => heard.push(e));
  const session = async (remember = false) => (await auth.createSession({ remember, ip: "1", userAgent: "" })).session;
  return { clock, store, auth, heard, session };
}

describe("ending credentials", () => {
  it("announces every way a session or token ends, so what it opened can be cut", async () => {
    const { auth, heard, session } = await setup();
    const a = await session();
    const b = await session(true);
    await auth.endSession(a.id);
    expect(heard.at(-1)).toEqual({ kind: "session", ids: [a.id] });
    await auth.endSessions(b.id);
    // Everything but the kept one — including sessions no longer in the store.
    expect(heard.at(-1)).toEqual({ kind: "session", allBut: b.id });
    await auth.endSessions();
    expect(heard.at(-1)).toEqual({ kind: "session", allBut: null });

    const tok = await auth.createToken("x");
    await auth.revokeToken(tok.record.id);
    expect(heard.at(-1)).toEqual({ kind: "token", ids: [tok.record.id] });
    await auth.revokeAllTokens();
    expect(heard.at(-1)).toEqual({ kind: "token", allBut: null });
  });

  it("announces a session pruned for idleness, and one past its 30 days", async () => {
    const { clock, auth, heard, session } = await setup();
    const idle = await session();
    const remembered = await session(true);
    clock.t += IDLE_MS + 1;
    await auth.prune();
    expect(heard.at(-1)).toEqual({ kind: "session", ids: [idle.id] });
    clock.t += ABSOLUTE_MS;
    await auth.prune();
    expect(heard.at(-1)).toEqual({ kind: "session", ids: [remembered.id] });
  });

  it("announces the sessions the cap evicts", async () => {
    const { clock, heard, session } = await setup();
    const first = await session();
    for (let i = 0; i < 49; i++) {
      clock.t += 1_000;
      await session();
    }
    expect(heard).toEqual([]);
    clock.t += 1_000;
    await session();
    expect(heard.at(-1)).toEqual({ kind: "session", ids: [first.id] });
  });

  it("counts use of a session — a request, or traffic on its sockets — against idleness", async () => {
    const { clock, auth, session } = await setup();
    const s = await session();
    clock.t += IDLE_MS - 1_000;
    auth.touchSession(s.id);
    clock.t += IDLE_MS - 1_000;
    expect(auth.listSessions().map((x) => x.id)).toEqual([s.id]);
    clock.t += 2_000;
    expect(auth.listSessions()).toEqual([]);
  });
});
