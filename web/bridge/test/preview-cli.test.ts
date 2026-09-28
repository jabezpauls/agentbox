import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventsMessage, SessionSnapshot } from "@workbench/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { BridgeEvents } from "../src/events.js";
import { AppsService } from "../src/apps/service.js";
import { listListeningPorts } from "../src/ports.js";
import type { SessionHub } from "../src/herdr/session.js";
import { FakeGate } from "./helpers/fake-gate.js";

// The CLI the image installs, run as the image runs it, against the bridge's
// real routes. herdr is stood in for by something that really runs the command
// it is sent, with the environment the tab was made with.
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../images/workspace/agentbox-preview");

const stubHub = {
  connected: true,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

let app: FastifyInstance;
let baseUrl: string;
let work: string;
const gate = new FakeGate();
const events: EventsMessage[] = [];
const children: ChildProcess[] = [];
const panes = new Map<string, { env: Record<string, string>; cwd: string; out: string }>();
const sent: string[] = [];

const snap: SessionSnapshot = {
  version: "1",
  protocol: 1,
  workspaces: [{ workspace_id: "w1", number: 1, label: "goofy", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }],
  tabs: [],
  panes: [{ pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "working", agent: "claude", revision: 1 }],
  layouts: [],
  agents: [{ pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "working", agent: "claude", display_agent: "claude", revision: 1, interactive_ready: true, launch_pending: false }],
};

async function herdr<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (method === "tab.create") {
    const id = `w1:p${panes.size + 2}`;
    panes.set(id, { env: params.env as Record<string, string>, cwd: String(params.cwd), out: "" });
    return { tab: { tab_id: `${id}-tab` }, root_pane: { pane_id: id, workspace_id: "w1" } } as T;
  }
  if (method === "pane.send_input") {
    const pane = panes.get(String(params.pane_id));
    if (!pane) throw new Error("no pane");
    sent.push(String(params.text));
    const child = spawn("sh", ["-c", String(params.text)], { cwd: pane.cwd, env: { ...process.env, ...pane.env } });
    child.stdout?.on("data", (d: Buffer) => (pane.out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (pane.out += d.toString()));
    children.push(child);
    return {} as T;
  }
  if (method === "pane.read") return { text: panes.get(String(params.pane_id))?.out ?? "" } as T;
  return {} as T;
}

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, AGENTBOX_PREVIEW_URL: baseUrl, HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", ...env }, cwd: work },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preview-cli-")));
  const bus = new BridgeEvents();
  bus.on((m) => events.push(m));
  const apps = new AppsService({
    gate,
    events: bus,
    scanPorts: async () => (await listListeningPorts({ systemPorts: [] })).ports,
    snapshot: async () => snap,
    herdr,
    herdrReady: () => true,
    stopGraceMs: 2_000,
  });
  const config = loadConfig({ WORKBENCH_PORT: "0", HERDR_SOCKET_PATH: "/does/not/exist-cli.sock", WORKBENCH_STATIC_DIR: "/does/not/exist" });
  app = await buildApp(config, { hub: stubHub, apps, events: bus });
  await app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}, 20_000);

afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  await app.close();
  fs.rmSync(work, { recursive: true, force: true });
});

/** A server that answers on $PORT, as a dev server started plainly would. */
const SERVER = `node -e "require('http').createServer((q,s)=>s.end('hi from '+q.url)).listen(process.env.PORT, process.env.HOST)"`;

describe("agentbox-preview start", () => {
  it("registers the app, runs it beside the agent with PORT set, waits for it, and shows it", async () => {
    const res = await cli(["start", "--name", "plain", "--", "sh", "-c", SERVER]);
    expect(res.stderr).toContain("starting plain");
    expect(res.code).toBe(0);
    const [url, ids] = res.stdout.trim().split("\n");
    const rec = gate.apps.find((a) => a.name === "plain");
    expect(rec).toMatchObject({ cwd: work, keepPrefix: false, createdBy: "agent" });
    expect(url).toBe(`/a/${rec?.id}/`);
    expect(ids).toContain(`id: ${rec?.id}`);
    expect(await (await fetch(`http://127.0.0.1:${rec?.port}/x`)).text()).toBe("hi from /x");
    // In a tab of the calling agent's workspace, and every open tab was told.
    expect(events.find((e) => e.kind === "app.open" && e.id === rec?.id)).toMatchObject({ by: "claude", name: "plain" });
  }, 30_000);

  it("adds Vite's base path and port, and records that the app keeps its prefix", async () => {
    const dir = path.join(work, "vite-app");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    // A stand-in for vite that says what it was given and fails, as a broken
    // dev server would (a real one may be on this PATH, and must not answer).
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", ".bin", "vite"), '#!/bin/sh\necho "vite got: $*"\nexit 1\n', { mode: 0o755 });
    const res = await cli(["start", "--cwd", dir, "--timeout", "2", "--", "npm", "run", "dev"]);
    const rec = gate.apps.find((a) => a.cwd === dir);
    expect(rec?.keepPrefix).toBe(true);
    expect(rec?.command).toBe(`npm run dev -- --base /a/${rec?.id}/ --port ${rec?.port} --strictPort --host 127.0.0.1`);
    // It never comes up: exit 5, with the last of its output.
    expect(res.code).toBe(5);
    expect(res.stderr).toContain("did not answer");
    expect(res.stderr).toContain(`vite got: --base /a/${rec?.id}/ --port ${rec?.port} --strictPort --host 127.0.0.1`);
  }, 30_000);

  it("quotes what it types into the shell", async () => {
    const dir = path.join(work, "quoted");
    fs.mkdirSync(dir);
    await cli(["start", "--cwd", dir, "--timeout", "1", "--no-open", "--", "echo", "it's $HOME", "a b"]);
    expect(sent.at(-1)).toBe(`echo 'it'\\''s $HOME' 'a b'`);
  }, 30_000);

  it("refuses a port something already serves", async () => {
    const srv = http.createServer((_q, s) => s.end("busy"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const res = await cli(["start", "--port", String(port), "--", "true"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`agentbox-preview open ${port}`);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

describe("agentbox-preview open, list, url, stop", () => {
  it("makes an app of a running server and shows it", async () => {
    const srv = http.createServer((_q, s) => s.end("up"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const res = await cli(["open", String(port), "--path", "/about"]);
    expect(res.code).toBe(0);
    const rec = gate.apps.find((a) => a.port === port);
    expect(rec).toBeDefined();
    expect(events.at(-1)).toMatchObject({ kind: "app.open", id: rec?.id, path: "/about" });
    expect((await cli(["url", String(port)])).stdout.trim()).toBe(`/a/${rec?.id}/`);
    expect((await cli(["list"])).stdout).toContain(`:${port}`);
    const listed = JSON.parse((await cli(["list", "--json"])).stdout) as Array<{ id: string; live: { listening: boolean } }>;
    expect(listed.find((a) => a.id === rec?.id)?.live.listening).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("says so for what does not exist", async () => {
    expect((await cli(["url", "abcdefghijklmnopqrstuvwxyz"])).code).toBe(2);
    expect((await cli(["open", "1"])).code).toBe(1);
    expect((await cli(["bogus"])).code).toBe(1);
  });

  it("stops the server and removes the app", async () => {
    const rec = gate.apps.find((a) => a.name === "plain");
    const res = await cli(["stop", String(rec?.id)]);
    expect(res.stdout).toContain("stopped");
    expect(gate.apps.some((a) => a.id === rec?.id)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${rec?.port}/`)).rejects.toThrow();
  }, 20_000);
});

describe("agentbox-preview static", () => {
  it("serves a folder as an app, and nothing outside it", async () => {
    const site = path.join(work, "site");
    fs.mkdirSync(path.join(site, "sub"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<h1>static</h1>");
    fs.writeFileSync(path.join(site, "sub", "a.css"), "b{}");
    fs.writeFileSync(path.join(work, "secret.txt"), "no");
    fs.symlinkSync(path.join(work, "secret.txt"), path.join(site, "leak.txt"));
    const res = await cli(["static", site, "--no-open"]);
    expect(res.code).toBe(0);
    const rec = gate.apps.find((a) => a.cwd === site);
    expect(rec?.name).toBe("site");
    const base = `http://127.0.0.1:${rec?.port}`;
    expect(await (await fetch(`${base}/`)).text()).toBe("<h1>static</h1>");
    const css = await fetch(`${base}/sub/a.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    for (const p of ["/leak.txt", "/../secret.txt", "/%2e%2e/secret.txt", "/nope"]) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
  }, 30_000);
});
