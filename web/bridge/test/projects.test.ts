import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { EventsMessage, ListeningPort, PaneInfo, Project, ProjectCloneEvent } from "@workbench/shared";
import { BridgeEvents } from "../src/events.js";
import { checkName, checkUrl, nameFromUrl, parseProgress, Projects, sweepClones } from "../src/projects.js";
import { filesFixture, tmpBase, type FilesFixture } from "./helpers/files.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });

describe("what a project may be called and cloned from", () => {
  it("takes one plain folder name", () => {
    expect(checkName("  my-app ")).toBe("my-app");
    expect(checkName("naïve app")).toBe("naïve app");
    for (const bad of ["", " ", ".", "..", ".hidden", "a/b", "a\\b", "a\0b", "a\nb", 42, undefined, "x".repeat(256)]) {
      expect(() => checkName(bad), String(bad)).toThrow();
    }
  });

  it("takes network URLs only", () => {
    for (const ok of ["https://github.com/o/r.git", "http://h/r", "ssh://git@h/r.git", "git://h/r", "git@github.com:o/r.git"]) {
      expect(checkUrl(ok)).toBe(ok);
    }
    for (const bad of [
      "file:///etc",
      "/local/repo",
      "../repo",
      "ext::sh -c touch% /tmp/pwned",
      "-uhttps://h/r",
      "--upload-pack=touch /tmp/x",
      "https://h/r x",
      "fd::/x",
      "ssh://-oProxyCommand=id/r",
      "ssh://git@-oProxyCommand=id/r",
      "-oProxyCommand@host:r",
      "git@-oProxyCommand:r",
      "",
    ]) {
      expect(() => checkUrl(bad), bad).toThrow();
    }
  });

  it("names a clone after its URL", () => {
    expect(nameFromUrl("https://github.com/o/repo.git")).toBe("repo");
    expect(nameFromUrl("git@github.com:o/Thing.git")).toBe("Thing");
    expect(nameFromUrl("https://h/a/b/")).toBe("b");
  });

  it("reads git's progress lines", () => {
    expect(parseProgress("Receiving objects:  42% (123/456), 1.2 MiB | 3 MiB/s")).toEqual({ stage: "Receiving objects", percent: 42 });
    expect(parseProgress("remote: Counting objects: 100% (5/5), done.")).toEqual({ stage: "Counting objects", percent: 100 });
    expect(parseProgress("Cloning into 'x'...")).toBeNull();
  });
});

describe("the project cards", () => {
  let f: FilesFixture;
  let ws: string;
  beforeAll(async () => {
    f = await filesFixture();
    ws = f.workspace;
    const repo = path.join(ws, "shop");
    fs.mkdirSync(path.join(repo, "web"), { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "hi");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(repo, "README.md"), "changed");
    fs.writeFileSync(path.join(repo, "new.txt"), "n");
    fs.mkdirSync(path.join(ws, "notes"));
    fs.mkdirSync(path.join(ws, ".hidden"));
    fs.writeFileSync(path.join(ws, "loose-file.txt"), "");
    fs.symlinkSync(f.base, path.join(ws, "escape"));
  });
  afterAll(async () => {
    await f.close();
  });

  it("describes each top-level folder with its git state, panes and servers", async () => {
    const pane = (id: string, cwd: string, agent: string | null): PaneInfo =>
      ({ pane_id: id, workspace_id: "w1", cwd, agent, agent_status: agent ? "working" : "unknown" }) as PaneInfo;
    const ports: ListeningPort[] = [
      { port: 5173, pid: 10, process: "node", system: false, address: "127.0.0.1", cwd: path.join(ws, "shop", "web") },
      { port: 7800, pid: 11, process: "node", system: true, address: "0.0.0.0", cwd: path.join(ws, "shop") },
      { port: 9000, pid: 12, process: "python3", system: false, address: "127.0.0.1", cwd: "/elsewhere" },
    ];
    const projects = new Projects({
      files: f.files,
      snapshot: async () => ({ panes: [pane("w1:p1", path.join(ws, "shop", "web"), "claude"), pane("w1:p2", "/tmp", null)] }),
      scanPorts: async () => ports,
      events: new BridgeEvents(),
    });
    const list = await projects.list();
    expect(list.map((p) => p.name).sort()).toEqual(["notes", "shop"]);
    const shop = list.find((p) => p.name === "shop") as Project;
    expect(shop.path).toBe(path.join(ws, "shop"));
    expect(shop.git).toMatchObject({ branch: "main", detached: false, upstream: null, ahead: 0, behind: 0, uncommitted: 2 });
    expect(shop.git?.lastCommit).toBeGreaterThan(0);
    expect(shop.agents).toEqual([{ paneId: "w1:p1", workspaceId: "w1", agent: "claude", status: "working", cwd: path.join(ws, "shop", "web") }]);
    expect(shop.listeners).toEqual([{ port: 5173, pid: 10, process: "node", cwd: path.join(ws, "shop", "web") }]);
    const notes = list.find((p) => p.name === "notes") as Project;
    expect(notes).toMatchObject({ git: null, agents: [], listeners: [] });
  });

  it("still lists projects when herdr and /proc cannot answer", async () => {
    const projects = new Projects({
      files: f.files,
      snapshot: async () => {
        throw new Error("no herdr");
      },
      scanPorts: async () => {
        throw new Error("no proc");
      },
      events: new BridgeEvents(),
    });
    expect((await projects.list()).map((p) => p.name).sort()).toEqual(["notes", "shop"]);
  });

  it("is served at /api/projects", async () => {
    const res = await f.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Project[]).map((p) => p.name).sort()).toEqual(["notes", "shop"]);
  });
});

/** A bare repository served over git's dumb HTTP protocol, by a static server. */
async function servedRepo(base: string): Promise<{ url: string; close(): Promise<void> }> {
  const work = path.join(base, "src-work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "hello.txt"), "from the remote");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "first");
  const served = path.join(base, "served");
  fs.mkdirSync(served);
  git(base, "clone", "-q", "--bare", work, path.join(served, "remote.git"));
  git(path.join(served, "remote.git"), "update-server-info");
  const server = http.createServer((req, res) => {
    const file = path.join(served, decodeURIComponent((req.url ?? "/").split("?")[0]!));
    if (!file.startsWith(served) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/remote.git`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("making projects", () => {
  let f: FilesFixture;
  let events: BridgeEvents;
  let remote: { url: string; close(): Promise<void> };
  const seen: ProjectCloneEvent[] = [];

  beforeAll(async () => {
    events = new BridgeEvents();
    events.on((m: EventsMessage) => {
      if (m.kind === "project.clone") seen.push(m);
    });
    f = await filesFixture({}, (files) => ({
      events,
      projects: new Projects({ files, snapshot: async () => ({ panes: [] }), scanPorts: async () => [], events }),
    }));
    remote = await servedRepo(fs.mkdtempSync(path.join(tmpBase(), "wb-remote-")));
  });
  afterAll(async () => {
    await remote.close();
    await f.close();
  });

  const post = (url: string, payload: object) => f.app.inject({ method: "POST", url, payload });

  async function until(pred: () => boolean, ms = 15_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("makes an empty folder, once", async () => {
    const res = await post("/api/projects", { name: "fresh" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "fresh", path: path.join(f.workspace, "fresh"), git: null });
    expect(fs.statSync(path.join(f.workspace, "fresh")).isDirectory()).toBe(true);
    expect((await post("/api/projects", { name: "fresh" })).statusCode).toBe(409);
    expect((await post("/api/projects", { name: "../escape" })).statusCode).toBe(400);
    expect((await post("/api/projects", {})).statusCode).toBe(400);
  });

  it("clones, reporting progress as events, and names the folder after the URL", async () => {
    const res = await post("/api/projects/clone", { url: remote.url });
    expect(res.statusCode).toBe(202);
    const started = res.json() as { id: string; name: string; path: string };
    expect(started).toMatchObject({ name: "remote", path: path.join(f.workspace, "remote") });
    await until(() => seen.some((e) => e.id === started.id && (e.phase === "done" || e.phase === "error")));
    const mine = seen.filter((e) => e.id === started.id);
    expect(mine[0]?.phase).toBe("started");
    expect(mine.at(-1)).toMatchObject({ phase: "done", name: "remote", url: remote.url });
    expect(fs.readFileSync(path.join(f.workspace, "remote", "hello.txt"), "utf8")).toBe("from the remote");
    // Nothing is left in scratch space.
    expect(fs.readdirSync(path.join(f.workspace, ".agentbox", "clones"))).toEqual([]);
    // The same name again is taken.
    expect((await post("/api/projects/clone", { url: remote.url })).statusCode).toBe(409);
  });

  it("reports a failed clone as an error event and leaves nothing behind", async () => {
    const res = await post("/api/projects/clone", { url: remote.url.replace("remote.git", "missing.git"), name: "nope" });
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };
    await until(() => seen.some((e) => e.id === id && (e.phase === "done" || e.phase === "error")));
    const last = seen.filter((e) => e.id === id).at(-1) as ProjectCloneEvent;
    expect(last.phase).toBe("error");
    expect(last.message).toBeTruthy();
    expect(fs.existsSync(path.join(f.workspace, "nope"))).toBe(false);
    expect(fs.readdirSync(path.join(f.workspace, ".agentbox", "clones"))).toEqual([]);
  });

  it("refuses URLs that are not network repositories", async () => {
    for (const url of ["file:///etc", "/srv/repo", "ext::sh -c id", "-uhttps://x/y"]) {
      expect((await post("/api/projects/clone", { url })).statusCode, url).toBe(400);
    }
  });

  it("forwards clone progress to every events socket", async () => {
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (f.app.server.address() as AddressInfo).port;
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { origin: `http://127.0.0.1:${port}` });
    const got = new Promise<EventsMessage>((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as EventsMessage;
        if (m.kind === "project.clone") resolve(m);
      });
    });
    await new Promise<void>((r) => ws.once("open", () => r()));
    events.emit({ kind: "project.clone", id: "x", name: "n", path: "/p", url: "u", phase: "progress", stage: "Receiving objects", percent: 5 });
    expect(await got).toMatchObject({ kind: "project.clone", stage: "Receiving objects", percent: 5 });
    ws.close();
  });

  it("sweeps clones a restart left behind, once they are a day old", async () => {
    const dir = path.join(f.workspace, ".agentbox", "clones");
    fs.mkdirSync(path.join(dir, "old"), { recursive: true });
    fs.mkdirSync(path.join(dir, "new"), { recursive: true });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, "old"), old, old);
    expect(await sweepClones(f.workspace)).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["new"]);
  });
});
