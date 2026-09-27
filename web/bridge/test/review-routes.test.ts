import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";
import { ReviewStore } from "../src/review/store.js";

// Review needs no herdr; a stub hub keeps the sibling routes registrable.
const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

let app: FastifyInstance;
let root: string;
let work: string;

beforeEach(async () => {
  const base = fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
  root = fs.mkdtempSync(path.join(base, "wb-rroutes-"));
  work = fs.mkdtempSync(path.join(base, "wb-rwork-"));
  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-review.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-review-static",
    WORKBENCH_REVIEW_DIR: root,
    WORKBENCH_PUBLIC_URL: "https://code.example.com",
  });
  app = await buildApp(config, { hub: stubHub, review: new ReviewStore(root) });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function artifact(name: string, body = "<h1>Plan</h1>"): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, `<!doctype html><html><body>${body}</body></html>`);
  return file;
}

async function open(file: string, label?: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/review/sessions",
    payload: label === undefined ? { file } : { file, label },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { key: string; url: string; resumed: boolean };
}

describe("review routes", () => {
  it("opens a session and answers with a browsable URL", async () => {
    const body = await open(artifact("plan.html"), "Rollout plan");
    expect(body.key).toMatch(/^[0-9a-f]{8}$/);
    expect(body.url).toBe(`https://code.example.com/workbench?review=${body.key}`);
    expect(body.resumed).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/review/sessions" });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].label).toBe("Rollout plan");
  });

  it("refuses an open with no file, and one it cannot read", async () => {
    const empty = await app.inject({ method: "POST", url: "/api/review/sessions", payload: {} });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/api/review/sessions",
      payload: { file: path.join(work, "nope.html") },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("serves the artifact with the annotator injected and the sandbox header set", async () => {
    const { key } = await open(artifact("plan.html"));
    const res = await app.inject({ method: "GET", url: `/api/review/${key}/artifact` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toContain("<h1>Plan</h1>");
    expect(res.body).toContain('data-agentbox-review="annotator"');
    // Injected before the closing body tag, not after it.
    expect(res.body.indexOf("data-agentbox-review")).toBeLessThan(res.body.indexOf("</body>"));
  });

  it("refuses a path traversal in the key", async () => {
    for (const key of ["..%2f..%2fetc%2fpasswd", "....", "ABCDEFGH"]) {
      const res = await app.inject({ method: "GET", url: `/api/review/${key}/artifact` });
      expect(res.statusCode).toBe(400);
    }
  });

  it("404s a well-formed key with no session behind it", async () => {
    const res = await app.inject({ method: "GET", url: "/api/review/0123abcd" });
    expect(res.statusCode).toBe(404);
  });

  it("round-trips a comment from the panel to the long poll", async () => {
    const { key } = await open(artifact("plan.html"));
    const posted = await app.inject({
      method: "POST",
      url: `/api/review/${key}/feedback`,
      payload: { comments: [{ kind: "element", anchor: "body > h1:nth-of-type(1)", quote: "Plan", note: "two phases" }] },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().session.pending).toBe(1);

    const polled = await app.inject({ method: "GET", url: `/api/review/${key}/feedback?wait=0` });
    expect(polled.json()).toMatchObject({ key, status: "open", timedOut: false });
    expect(polled.json().comments[0].note).toBe("two phases");
  });

  it("ends a session from the panel and from the CLI", async () => {
    const fromPanel = await open(artifact("a.html"));
    const posted = await app.inject({
      method: "POST",
      url: `/api/review/${fromPanel.key}/feedback`,
      payload: { comments: [{ kind: "note", note: "done" }], end: true },
    });
    expect(posted.json().session).toMatchObject({ status: "ended", endedBy: "human" });

    const fromCli = await open(artifact("b.html"));
    const ended = await app.inject({
      method: "POST",
      url: `/api/review/${fromCli.key}/end`,
      payload: { by: "agent" },
    });
    expect(ended.json()).toMatchObject({ status: "ended", endedBy: "agent" });
  });
});
