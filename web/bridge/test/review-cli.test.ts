import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";
import { ReviewStore } from "../src/review/store.js";

// The CLI the image installs, run as the image runs it. Exercising the shipped
// file rather than a copy is the point: the exit codes an agent depends on are
// only meaningful if they are this file's.
const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../images/workspace/agentbox-review",
);

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
let store: ReviewStore;
let root: string;
let work: string;
let baseUrl: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI against the test bridge and report what an agent would see. */
function cli(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, AGENTBOX_REVIEW_URL: baseUrl } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function artifact(name: string, body = "<h1>Plan</h1>"): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, `<!doctype html><html><body>${body}</body></html>`);
  return file;
}

beforeAll(async () => {
  const base = fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
  root = fs.mkdtempSync(path.join(base, "wb-cli-"));
  work = fs.mkdtempSync(path.join(base, "wb-cliwork-"));
  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-cli.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-cli-static",
    WORKBENCH_REVIEW_DIR: root,
  });
  store = new ReviewStore(root);
  app = await buildApp(config, { hub: stubHub, review: store });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe("agentbox-review", () => {
  it("opens a session, lists it, and polls the comments a human sent", async () => {
    const file = artifact("plan.html");
    const opened = await cli("open", file, "--label", "Rollout plan");
    expect(opened.code).toBe(0);
    const key = /key: ([0-9a-f]{8})/.exec(opened.stdout)?.[1];
    expect(key).toBeTruthy();
    expect(opened.stdout).toContain(`/workbench?review=${key}`);

    const listed = await cli("list");
    expect(listed.stdout).toContain("Rollout plan");

    await store.post(key as string, [
      { kind: "element", anchor: "body > h1:nth-of-type(1)", quote: "Plan", note: "split this in two" },
    ]);

    const polled = await cli("poll", key as string, "--timeout", "10");
    expect(polled.code).toBe(0);
    const json = JSON.parse(polled.stdout) as { key: string; status: string; comments: { note: string }[] };
    expect(json).toMatchObject({ key, status: "open" });
    expect(json.comments[0]?.note).toBe("split this in two");
    // The documented shape and nothing else, so a caller can parse it blind.
    expect(Object.keys(json).sort()).toEqual(["comments", "key", "status"]);
  });

  it("accepts the file path in place of the key", async () => {
    const file = artifact("by-path.html");
    await cli("open", file);
    const listed = await cli("list", "--json");
    const sessions = JSON.parse(listed.stdout) as { file: string }[];
    expect(sessions.some((s) => s.file === file)).toBe(true);

    const ended = await cli("end", file);
    expect(ended.code).toBe(0);
    expect(ended.stdout).toContain("ended");
  });

  it("exits 3 when the wait elapses with nothing queued", async () => {
    const file = artifact("quiet.html");
    const opened = await cli("open", file);
    const key = /key: ([0-9a-f]{8})/.exec(opened.stdout)?.[1] as string;
    const polled = await cli("poll", key, "--timeout", "1");
    expect(polled.code).toBe(3);
    expect(JSON.parse(polled.stdout).comments).toEqual([]);
  });

  it("exits 4 once the human has ended the session, after its final comments", async () => {
    const file = artifact("ending.html");
    const opened = await cli("open", file);
    const key = /key: ([0-9a-f]{8})/.exec(opened.stdout)?.[1] as string;
    await store.post(key, [{ kind: "note", note: "last word" }], true);

    const polled = await cli("poll", key, "--timeout", "10");
    expect(polled.code).toBe(4);
    const json = JSON.parse(polled.stdout) as { status: string; comments: { note: string }[] };
    expect(json.status).toBe("ended");
    expect(json.comments.map((c) => c.note)).toEqual(["last word"]);
  });

  it("exits 2 on an unknown session and 1 on an unreadable file", async () => {
    expect((await cli("poll", "00000000", "--timeout", "1")).code).toBe(2);
    const missing = await cli("open", path.join(work, "nope.html"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read");
  });

  it("returns as soon as a comment is posted, rather than waiting out the timeout", async () => {
    const file = artifact("waiting.html");
    const opened = await cli("open", file);
    const key = /key: ([0-9a-f]{8})/.exec(opened.stdout)?.[1] as string;

    const started = Date.now();
    const polling = cli("poll", key, "--timeout", "20");
    await new Promise((r) => setTimeout(r, 300));
    await store.post(key, [{ kind: "note", note: "ship it" }]);

    const polled = await polling;
    expect(polled.code).toBe(0);
    expect(JSON.parse(polled.stdout).comments[0].note).toBe("ship it");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
