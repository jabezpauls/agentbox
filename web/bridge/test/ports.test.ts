import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProcNetTcp, listListeningPorts, isSystemPort, PortsWatcher } from "../src/ports.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures/proc-net-tcp.txt"), "utf8");

describe("parseProcNetTcp", () => {
  it("keeps only LISTEN (0A) rows and decodes port + IPv4 address", () => {
    const rows = parseProcNetTcp(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ port: 3000, address: "0.0.0.0", inode: 987654 });
  });

  it("decodes little-endian IPv4 loopback", () => {
    const text =
      "  sl  local_address rem_address st\n" +
      "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 42 1\n";
    const rows = parseProcNetTcp(text);
    expect(rows[0]).toEqual({ port: 8080, address: "127.0.0.1", inode: 42 });
  });

  it("decodes IPv6 wildcard and loopback", () => {
    const text =
      "  sl  local_address rem_address st\n" +
      "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 7 1\n" +
      "   1: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 9 1\n";
    const rows = parseProcNetTcp(text);
    expect(rows[0]).toEqual({ port: 8080, address: "::", inode: 7 });
    expect(rows[1]).toEqual({ port: 80, address: "::1", inode: 9 });
  });
});

describe("isSystemPort", () => {
  const set = (...ports: number[]) => new Set(ports);

  it("flags a configured system port", () => {
    expect(isSystemPort({ port: 8080, systemPorts: set(8080), cwd: null, workspaceRoot: null })).toBe(true);
  });

  it("flags a well-known host-daemon port regardless of owner", () => {
    for (const port of [53, 67, 68, 123, 631, 5353]) {
      expect(isSystemPort({ port, systemPorts: set(), cwd: "/workspace/app", workspaceRoot: "/workspace" })).toBe(true);
    }
  });

  it("keeps a workspace-owned dev-server port as previewable", () => {
    expect(
      isSystemPort({ port: 3000, systemPorts: set(), cwd: "/workspace/app", workspaceRoot: "/workspace" }),
    ).toBe(false);
    // The root itself counts as under the root.
    expect(
      isSystemPort({ port: 3000, systemPorts: set(), cwd: "/workspace", workspaceRoot: "/workspace" }),
    ).toBe(false);
  });

  it("flags a port whose owner runs outside the workspace root", () => {
    expect(
      isSystemPort({ port: 3000, systemPorts: set(), cwd: "/usr/lib/thing", workspaceRoot: "/workspace" }),
    ).toBe(true);
  });

  it("flags a port with an unattributable owner once a workspace root is known", () => {
    expect(isSystemPort({ port: 3000, systemPorts: set(), cwd: null, workspaceRoot: "/workspace" })).toBe(true);
  });

  it("does not apply the workspace test when no root is configured", () => {
    expect(isSystemPort({ port: 3000, systemPorts: set(), cwd: null, workspaceRoot: null })).toBe(false);
  });

  it("does not treat a prefix-sibling directory as under the root", () => {
    expect(
      isSystemPort({ port: 3000, systemPorts: set(), cwd: "/workspace-evil/app", workspaceRoot: "/workspace" }),
    ).toBe(true);
  });
});

describe("listListeningPorts", () => {
  it("reports a real listening socket with its owning process", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const { ports } = await listListeningPorts({ systemPorts: [port] });
      const found = ports.find((p) => p.port === port);
      expect(found).toBeDefined();
      expect(found?.system).toBe(true);
      // On Linux with /proc access the socket maps back to this process.
      if (found?.pid !== null) {
        expect(found?.pid).toBe(process.pid);
        expect(found?.process).toBeTruthy();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("dedupes by port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const { ports } = await listListeningPorts({ systemPorts: [] });
      const matches = ports.filter((p) => p.port === port);
      expect(matches).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports the port set as readable when /proc could be read", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const scan = await listListeningPorts({ systemPorts: [] });
      // On any Linux CI box /proc/net/tcp exists, so this is a genuine read.
      expect(scan.readable).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("PortsWatcher", () => {
  it("emits only when the port set changes and stops polling on stop()", async () => {
    let calls = 0;
    const scripted = [
      [{ port: 3000, pid: 1, process: "a", system: false, address: "0.0.0.0" }],
      [{ port: 3000, pid: 1, process: "a", system: false, address: "0.0.0.0" }],
      [
        { port: 3000, pid: 1, process: "a", system: false, address: "0.0.0.0" },
        { port: 4000, pid: 2, process: "b", system: false, address: "0.0.0.0" },
      ],
    ];
    const watcher = new PortsWatcher({
      systemPorts: [],
      intervalMs: 10,
      list: async () => ({ ports: scripted[Math.min(calls++, scripted.length - 1)]!, readable: true }),
    });
    const seen: number[] = [];
    watcher.on((ports) => seen.push(ports.length));
    watcher.start();
    await new Promise((r) => setTimeout(r, 80));
    watcher.stop();
    const callsAtStop = calls;
    await new Promise((r) => setTimeout(r, 40));
    // First poll emits (1 port), the duplicate poll does not, the third emits (2 ports).
    expect(seen).toEqual([1, 2]);
    expect(watcher.current()).toHaveLength(2);
    // No further polling after stop().
    expect(calls).toBe(callsAtStop);
  });

  it("re-emits when readability flips even though the port list is unchanged", async () => {
    const scans = [
      { ports: [{ port: 3000, pid: 1, process: "a", system: false, address: "0.0.0.0" }], readable: true },
      { ports: [], readable: false },
      { ports: [], readable: false },
    ];
    let i = 0;
    const watcher = new PortsWatcher({
      systemPorts: [],
      intervalMs: 10,
      list: async () => scans[Math.min(i++, scans.length - 1)]!,
    });
    const seen: boolean[] = [];
    watcher.on(() => seen.push(watcher.readable()));
    watcher.start();
    await new Promise((r) => setTimeout(r, 60));
    watcher.stop();
    // The readable→unreadable transition is an event; the repeat is not.
    expect(seen).toEqual([true, false]);
    expect(watcher.readable()).toBe(false);
  });
});
