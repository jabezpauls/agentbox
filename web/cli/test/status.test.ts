import type { SessionSnapshot } from "@workbench/shared";
import { afterEach, describe, expect, it } from "vitest";
import { agentRows, agentTally, openTarget, systemLine } from "../src/commands/status.js";
import { EXIT } from "../src/errors.js";
import { formatAgo, formatBytes, formatDuration, table } from "../src/format.js";
import { VERSION } from "../src/version.js";
import { json, runCli, signedIn, stubServer, TOKEN, type Stub } from "./helpers.js";

const SNAPSHOT = {
  version: "0.9.1",
  protocol: 1,
  workspaces: [
    { workspace_id: "w1", label: "demo" },
    { workspace_id: "w2", label: "other" },
  ],
  tabs: [],
  panes: [],
  layouts: [],
  agents: [
    { pane_id: "p1", workspace_id: "w1", agent_status: "working", agent: "claude", cwd: "/workspace/demo" },
    { pane_id: "p2", workspace_id: "w2", agent_status: "blocked", display_agent: "codex", foreground_cwd: "/workspace/other/x" },
    { pane_id: "p3", workspace_id: "w1", agent_status: "working", agent: "claude" },
  ],
} as unknown as SessionSnapshot;

const SYSTEM = {
  sandbox: { cpu: 0.42, memory: 1.5 * 1024 ** 3, processes: 40 },
  host: { cores: 8, memory: 16 * 1024 ** 3 },
  container: { cpu: { limit: 4 }, memory: { used: 1, limit: 8 * 1024 ** 3 } },
  disks: [{ label: "workspace", path: "/workspace", total: 50 * 1024 ** 3, available: 12 * 1024 ** 3 }],
  uptime: { box: 3 * 86400 + 4 * 3600 },
};

describe("status's pieces", () => {
  it("names agents by workspace and tallies them worst first", () => {
    const rows = agentRows(SNAPSHOT);
    expect(rows).toEqual([
      { paneId: "p1", agent: "claude", status: "working", workspace: "demo", cwd: "/workspace/demo" },
      { paneId: "p2", agent: "codex", status: "blocked", workspace: "other", cwd: "/workspace/other/x" },
      { paneId: "p3", agent: "claude", status: "working", workspace: "demo", cwd: null },
    ]);
    expect(agentTally(rows)).toBe("3 — 1 blocked, 2 working");
    expect(agentTally([])).toBe("none");
  });

  it("sums up the system in a line", () => {
    expect(systemLine(SYSTEM)).toBe("CPU 0.4 of 4 cores · memory 1.5 GiB of 8.0 GiB · workspace 12.0 GiB free of 50.0 GiB · up 3d 4h");
    expect(systemLine({})).toBe("-");
  });

  it("opens surfaces by name, and paths in Files", () => {
    expect(openTarget(undefined)).toBe("/");
    expect(openTarget("workbench")).toBe("/workbench");
    expect(openTarget("Terminal")).toBe("/terminal/");
    expect(openTarget("proj/README.md")).toBe("/files/workspace/proj/README.md");
    expect(openTarget("/workspace/a b/../c#d")).toBe("/files/workspace/c%23d");
  });

  it("formats sizes, times and tables", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300 MiB");
    expect(formatBytes(null)).toBe("-");
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(7200)).toBe("2h 0m");
    expect(formatAgo(1000, 1000 + 3 * 3600_000)).toBe("3 hours ago");
    expect(formatAgo(0)).toBe("never");
    expect(table(["A", "BB"], [["xxx", "y"], ["z", "wwww"]])).toBe("A    BB\nxxx  y\nz    wwww\n");
    expect(table(["SIZE", "NAME"], [["1 B", "a"], ["10 KiB", "b"]], ["right"])).toBe("  SIZE  NAME\n   1 B  a\n10 KiB  b\n");
  });
});

describe("the status command", () => {
  let box: Stub | null = null;
  afterEach(async () => {
    await box?.close();
    box = null;
  });

  async function statusBox(opts: { apps?: number } = {}): Promise<string> {
    box = await stubServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, {});
      switch (req.url) {
        case "/_gate/version":
          return json(res, 200, { version: VERSION });
        case "/_gate/session":
          return json(res, 200, { kind: "token", id: "t", user: "owner", name: "cli", createdAt: 1 });
        case "/api/health":
          return json(res, 200, { ok: true, herdr: { connected: true, version: "0.9.1" } });
        case "/api/session":
          return json(res, 200, SNAPSHOT);
        case "/api/system":
          return json(res, 200, SYSTEM);
        case "/api/apps":
          return opts.apps === undefined
            ? json(res, 404, { error: "not found" })
            : json(res, 200, Array.from({ length: opts.apps }, (_, i) => ({ id: `app${i}`, name: `app-${i}`, port: 5170 + i, listening: true, visibility: { mode: i === 0 ? "link" : "private" } })));
      }
      json(res, 404, {});
    });
    return signedIn(box.url);
  }

  it("reports version, agents, apps and system", async () => {
    const r = await runCli(["status"], { configDir: await statusBox({ apps: 2 }) });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`agentbox ${VERSION} · signed in as owner`);
    expect(r.stdout).toMatch(/herdr\s+connected, 0\.9\.1/);
    expect(r.stdout).toMatch(/agents\s+3 — 1 blocked, 2 working/);
    expect(r.stdout).toMatch(/codex\s+blocked\s+other\s+\/workspace\/other\/x/);
    expect(r.stdout).toMatch(/apps\s+2 \(1 shared\)/);
    expect(r.stdout).toMatch(/system\s+CPU 0\.4 of 4 cores/);
  });

  it("gets on without apps on a box that has none yet", async () => {
    const r = await runCli(["status"], { configDir: await statusBox() });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/apps\s+not available on this box yet/);
  });

  it("prints JSON, without the token", async () => {
    const r = await runCli(["status", "--json"], { configDir: await statusBox({ apps: 1 }) });
    const s = JSON.parse(r.stdout);
    expect(s).toMatchObject({ box: { name: "test", version: VERSION, user: "owner" }, cli: { version: VERSION }, herdr: { connected: true } });
    expect(s.agents).toHaveLength(3);
    expect(s.apps).toHaveLength(1);
    expect(r.stdout).not.toContain(TOKEN);
  });

  it("says what it could not read, and fails", async () => {
    box = await stubServer((req, res) => {
      if (req.url === "/_gate/version") return json(res, 200, { version: VERSION });
      if (req.url === "/_gate/session") return json(res, 200, { user: "owner" });
      json(res, 502, { error: "bad gateway" });
    });
    const r = await runCli(["status"], { configDir: signedIn(box.url) });
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.stdout).toMatch(/herdr\s+unknown: reading health: .*bad gateway/);
  });

  it("warns when the box runs another version", async () => {
    box = await stubServer((req, res) => {
      if (req.url === "/_gate/version") return json(res, 200, { version: "99.0.0" });
      json(res, 200, { user: "owner", name: "cli" });
    });
    const cfg = signedIn(box.url, TOKEN, { versionCheckedAt: 0 });
    const r = await runCli(["whoami"], { configDir: cfg });
    expect(r.stderr).toMatch(/this CLI is agentbox .* but test .* runs 99\.0\.0; run `agentbox update`/);
    // Asked once a day, not on every command.
    const before = box.seen.filter((s) => s.url === "/_gate/version").length;
    await runCli(["open", "--print"], { configDir: cfg });
    expect(box.seen.filter((s) => s.url === "/_gate/version").length).toBe(before);
  });

  it("shows nothing the box says as terminal control: status, whoami, warnings and errors", async () => {
    const evil = "\x1b]0;PWNED\x07\x1b[31m";
    box = await stubServer((req, res) => {
      switch (req.url) {
        case "/_gate/version":
          return json(res, 200, { version: `9${evil}` });
        case "/_gate/session":
          return json(res, 200, { kind: "token", id: "t", user: `own${evil}er`, name: `dev${evil}`, createdAt: 1 });
        case "/api/health":
          return json(res, 200, { ok: true, herdr: { connected: true, version: `0.9${evil}` } });
        case "/api/session":
          return json(res, 200, { ...SNAPSHOT, agents: [{ pane_id: "p", workspace_id: "w1", agent_status: `blocked${evil}`, agent: `cl${evil}aude` }] });
        case "/api/apps":
          return json(res, 200, [{ id: "a", name: `app${evil}`, port: 1, visibility: { mode: `link${evil}` } }]);
        case "/api/system":
          return json(res, 500, { error: `system${evil} broke` });
      }
      json(res, 404, {});
    });
    const cfg = signedIn(box.url, TOKEN, { versionCheckedAt: 0 });
    for (const argv of [["status"], ["whoami"], ["boxes"]]) {
      const r = await runCli(argv, { configDir: cfg });
      for (const out of [r.stdout, r.stderr]) {
        expect(out, argv.join(" ")).not.toContain("\x1b");
        expect(out, argv.join(" ")).not.toContain("\x07");
      }
    }
    const r = await runCli(["status"], { configDir: cfg });
    expect(r.stdout).toContain("\\x1b]0;PWNED\\x07");
    expect(r.stdout).toMatch(/system\s+unknown: reading system: system\\x1b/);
  });
});
