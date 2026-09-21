import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyForFile, NotFoundError, ReviewStore } from "../src/review/store.js";

let root: string;
let work: string;
let store: ReviewStore;

function artifact(name: string, body = "<h1>Plan</h1>"): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, `<!doctype html><html><body>${body}</body></html>`);
  return file;
}

beforeEach(() => {
  const base = fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
  root = fs.mkdtempSync(path.join(base, "wb-review-"));
  work = fs.mkdtempSync(path.join(base, "wb-work-"));
  store = new ReviewStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe("session store", () => {
  it("creates a session, copies the artifact, and keys it by path", async () => {
    const file = artifact("plan.html");
    const { key, resumed, session } = await store.open(file, "Rollout plan");
    expect(key).toBe(keyForFile(file));
    expect(resumed).toBe(false);
    expect(session.label).toBe("Rollout plan");
    expect(await store.artifact(key)).toContain("<h1>Plan</h1>");
  });

  it("resumes the same path rather than accumulating duplicates", async () => {
    const file = artifact("plan.html");
    const first = await store.open(file);
    fs.writeFileSync(file, "<!doctype html><html><body><h1>Revised</h1></body></html>");
    const second = await store.open(file);
    expect(second.key).toBe(first.key);
    expect(second.resumed).toBe(true);
    // A resumed session shows the artifact as it is now, not as it first was.
    expect(await store.artifact(second.key)).toContain("Revised");
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps the original label when a resume does not pass one", async () => {
    const file = artifact("plan.html");
    await store.open(file, "Rollout plan");
    const again = await store.open(file);
    expect(again.session.label).toBe("Rollout plan");
  });

  it("ends a session and records who ended it", async () => {
    const { key } = await store.open(artifact("plan.html"));
    const ended = await store.end(key, "agent");
    expect(ended.status).toBe("ended");
    expect(ended.endedBy).toBe("agent");
  });

  it("lists sessions newest first", async () => {
    const a = await store.open(artifact("a.html"));
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.open(artifact("b.html"));
    const list = await store.list();
    expect(list.map((s) => s.key)).toEqual([b.key, a.key]);
  });

  it("tolerates a corrupt session.json instead of failing the list", async () => {
    const good = await store.open(artifact("good.html"));
    fs.mkdirSync(path.join(root, "deadbeef"));
    fs.writeFileSync(path.join(root, "deadbeef", "session.json"), "{ not json");
    const list = await store.list();
    expect(list.map((s) => s.key)).toEqual([good.key]);
  });

  it("refuses a key that is not a session hash", async () => {
    await expect(store.artifact("../../etc/passwd")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("feedback queue", () => {
  it("returns then clears what was posted", async () => {
    const { key } = await store.open(artifact("plan.html"));
    await store.post(key, [{ kind: "element", anchor: "h1", quote: "Plan", note: "split this" }]);

    const first = await store.take(key, 0);
    expect(first.comments).toHaveLength(1);
    expect(first.comments[0]).toMatchObject({ kind: "element", anchor: "h1", note: "split this" });
    expect(first.timedOut).toBe(false);

    const second = await store.take(key, 0);
    expect(second.comments).toEqual([]);
    expect(second.timedOut).toBe(true);
  });

  it("drops a comment with no note, and downgrades an unknown kind", async () => {
    const { key } = await store.open(artifact("plan.html"));
    await store.post(key, [{ kind: "element", note: "   " }, { kind: "wat", note: "fine" }]);
    const got = await store.take(key, 0);
    expect(got.comments).toHaveLength(1);
    expect(got.comments[0]?.kind).toBe("note");
  });

  it("wakes a waiting poller the moment feedback is posted", async () => {
    const { key } = await store.open(artifact("plan.html"));
    const started = Date.now();
    const polling = store.take(key, 5_000);
    // Let the poller park before posting, so this exercises the wake-up rather
    // than the fast path.
    await new Promise((r) => setTimeout(r, 50));
    await store.post(key, [{ kind: "note", note: "looks good" }]);
    const got = await polling;
    expect(got.comments.map((c) => c.note)).toEqual(["looks good"]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not let two pollers consume the same queue", async () => {
    const { key } = await store.open(artifact("plan.html"));
    const a = store.take(key, 1_000);
    const b = store.take(key, 1_000);
    await new Promise((r) => setTimeout(r, 50));
    await store.post(key, [{ kind: "note", note: "only once" }]);
    const [ra, rb] = await Promise.all([a, b]);
    const total = ra.comments.length + rb.comments.length;
    expect(total).toBe(1);
    // Whichever missed out waited out its timeout rather than getting a copy.
    expect(ra.timedOut !== rb.timedOut).toBe(true);
  });

  it("delivers an ended session's final comments once, then reports ended", async () => {
    const { key } = await store.open(artifact("plan.html"));
    await store.post(key, [{ kind: "note", note: "last word" }], true);

    const first = await store.take(key, 0);
    expect(first.status).toBe("ended");
    expect(first.comments.map((c) => c.note)).toEqual(["last word"]);

    const second = await store.take(key, 0);
    expect(second.status).toBe("ended");
    expect(second.comments).toEqual([]);
  });

  it("wakes a parked poller when the session ends with nothing queued", async () => {
    const { key } = await store.open(artifact("plan.html"));
    const polling = store.take(key, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    await store.end(key, "human");
    const got = await polling;
    expect(got.status).toBe("ended");
    expect(got.timedOut).toBe(false);
  });

  it("starts a re-opened session with an empty queue", async () => {
    const file = artifact("plan.html");
    const { key } = await store.open(file);
    await store.post(key, [{ kind: "note", note: "stale" }], true);
    await store.open(file);
    const detail = await store.get(key);
    expect(detail.session.status).toBe("open");
    expect(detail.comments).toEqual([]);
  });
});

describe("pruning", () => {
  /** Backdate a session's `updated` so the TTL sweep considers it old. */
  function age(key: string, daysAgo: number, status: "open" | "ended" = "ended"): void {
    const file = path.join(root, key, "session.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    s.status = status;
    if (status === "ended") s.endedBy = "agent";
    s.updated = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  }

  it("deletes ended sessions older than the TTL on the next open", async () => {
    const old = await store.open(artifact("old.html"));
    age(old.key, 8); // older than the 7-day TTL, and ended
    const recent = await store.open(artifact("recent.html"));
    age(recent.key, 1); // ended yesterday, still inside the TTL

    // Opening a fresh session triggers the sweep.
    await store.open(artifact("trigger.html"));

    const keys = (await store.list()).map((s) => s.key);
    expect(keys).not.toContain(old.key);
    expect(keys).toContain(recent.key);
  });

  it("keeps an old but still-open session", async () => {
    const openOld = await store.open(artifact("live.html"));
    age(openOld.key, 30, "open"); // ancient, but never ended

    await store.open(artifact("trigger.html"));

    expect((await store.list()).map((s) => s.key)).toContain(openOld.key);
  });

  it("never prunes the session just opened, even if it looks aged", async () => {
    // Re-opening resets status to open and updated to now, so a resume is safe.
    const file = artifact("resumed.html");
    const first = await store.open(file);
    age(first.key, 100);
    const again = await store.open(file);
    expect(again.resumed).toBe(true);
    expect((await store.list()).map((s) => s.key)).toContain(first.key);
  });
});
