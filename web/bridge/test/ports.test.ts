import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProcNetTcp, listListeningPorts, PortsWatcher } from "../src/ports.js";

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

describe("listListeningPorts", () => {
  it("reports a real listening socket with its owning process", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const ports = await listListeningPorts({ systemPorts: [port] });
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
      const ports = await listListeningPorts({ systemPorts: [] });
      const matches = ports.filter((p) => p.port === port);
      expect(matches).toHaveLength(1);
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
      list: async () => scripted[Math.min(calls++, scripted.length - 1)]!,
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
});
