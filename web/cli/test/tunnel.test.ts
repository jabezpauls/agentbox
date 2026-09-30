import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { forward } from "../src/commands/forward.js";
import { EXIT } from "../src/errors.js";
import { BoxClient } from "../src/http.js";
import { forwardPort, openTunnel, parseForwardSpec, targetParam, TunnelError } from "../src/tunnel.js";
import { capture, fakeStdin, runCli, signedIn, TOKEN } from "./helpers.js";

/**
 * A stand-in for the gate's tunnel endpoint as Phase C specifies it: a
 * WebSocket at /_gate/tunnel?target=…, bearer only, binary frames of raw
 * bytes both ways to a TCP target, a text error frame then close when the
 * target cannot be reached.
 */
async function stubTunnelGate(opts: { status?: number; silent?: boolean } = {}) {
  const server = http.createServer();
  // `silent`: a gate that has stopped answering (no pongs).
  const wss = new WebSocketServer({ noServer: true, autoPong: !opts.silent });
  const targets: string[] = [];
  let pings = 0;
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (opts.status || url.pathname !== "/_gate/tunnel" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end(`HTTP/1.1 ${opts.status ?? 401} No\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const target = url.searchParams.get("target") ?? "";
    targets.push(target);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("ping", () => (pings += 1));
      const m = /^tcp:(\d+)$/.exec(target);
      if (!m) {
        ws.send(JSON.stringify({ type: "error", message: "unknown target" }));
        ws.close();
        return;
      }
      const upstream = net.connect(Number(m[1]), "127.0.0.1");
      upstream.on("error", () => {
        ws.send(JSON.stringify({ type: "error", message: `nothing is listening on ${m[1]}` }));
        ws.close();
      });
      upstream.on("data", (d) => ws.send(d, { binary: true }));
      upstream.on("end", () => ws.close());
      ws.on("message", (d: Buffer, isBinary) => {
        if (isBinary) upstream.write(d);
      });
      ws.on("close", () => upstream.destroy());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    targets,
    pings: () => pings,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A TCP service in the "box": uppercases what it gets. */
async function upperServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((s) => s.on("data", (d) => s.write(d.toString().toUpperCase())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("tunnels", () => {
  it("name their target as the gate expects", () => {
    expect(targetParam({ kind: "tcp", port: 5173 })).toBe("tcp:5173");
    expect(targetParam({ kind: "herdr" })).toBe("herdr");
    expect(parseForwardSpec("5173")).toEqual({ remote: 5173, local: 5173 });
    expect(parseForwardSpec("8080:18080")).toEqual({ remote: 8080, local: 18080 });
    for (const bad of ["", "0", "70000", "a:b", "1:2:3", "5173:"]) expect(() => parseForwardSpec(bad), bad).toThrow(/not a port/);
  });

  it("carry bytes both ways, with the token, and keep themselves alive", async () => {
    const gate = await stubTunnelGate();
    const up = await upperServer();
    cleanups.push(gate.close, up.close);
    const t = await openTunnel(new BoxClient(gate.url, TOKEN), { kind: "tcp", port: up.port }, { pingMs: 20 });
    const got = new Promise<string>((r) => t.once("data", (d: Buffer) => r(d.toString())));
    t.write("hello tunnel");
    expect(await got).toBe("HELLO TUNNEL");
    await new Promise((r) => setTimeout(r, 80));
    expect(gate.pings()).toBeGreaterThan(0);
    expect(gate.targets).toEqual([`tcp:${up.port}`]);
    t.destroy();
  });

  it("close themselves when the box stops answering pings", async () => {
    const gate = await stubTunnelGate({ silent: true });
    const up = await upperServer();
    cleanups.push(gate.close, up.close);
    const t = await openTunnel(new BoxClient(gate.url, TOKEN), { kind: "tcp", port: up.port }, { pingMs: 20 });
    const err = await new Promise<Error>((r) => t.once("error", r));
    expect(err).toBeInstanceOf(TunnelError);
    expect(err.message).toMatch(/stopped answering/);
  });

  it("fail with the gate's own words on an error frame", async () => {
    const gate = await stubTunnelGate();
    cleanups.push(gate.close);
    const closed = await (async () => {
      const s = net.createServer();
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const port = (s.address() as AddressInfo).port;
      await new Promise((r) => s.close(r));
      return port;
    })();
    const t = await openTunnel(new BoxClient(gate.url, TOKEN), { kind: "tcp", port: closed });
    const err = await new Promise<Error>((r) => t.once("error", r));
    expect(err).toBeInstanceOf(TunnelError);
    expect(err.message).toBe(`nothing is listening on ${closed}`);
  });

  it("say when the box has no tunnels, or refuses the token", async () => {
    const old = await stubTunnelGate({ status: 404 });
    cleanups.push(old.close);
    await expect(openTunnel(new BoxClient(old.url, TOKEN), { kind: "herdr" })).rejects.toMatchObject({ exitCode: EXIT.NOT_FOUND });
    const gate = await stubTunnelGate();
    cleanups.push(gate.close);
    await expect(openTunnel(new BoxClient(gate.url, "abx_wrong"), { kind: "herdr" })).rejects.toMatchObject({ exitCode: EXIT.AUTH });
  });

  it("forward a local port, a tunnel per connection", async () => {
    const gate = await stubTunnelGate();
    const up = await upperServer();
    cleanups.push(gate.close, up.close);
    const free = await (async () => {
      const s = net.createServer();
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const port = (s.address() as AddressInfo).port;
      await new Promise((r) => s.close(r));
      return port;
    })();
    const server = await forwardPort(new BoxClient(gate.url, TOKEN), { remote: up.port, local: free });
    cleanups.push(() => void server.close());
    for (const word of ["one", "two"]) {
      const answer = await new Promise<string>((resolve, reject) => {
        const c = net.connect(free, "127.0.0.1", () => c.write(word));
        c.once("data", (d) => {
          resolve(d.toString());
          c.destroy();
        });
        c.once("error", reject);
      });
      expect(answer).toBe(word.toUpperCase());
    }
    expect(gate.targets).toEqual([`tcp:${up.port}`, `tcp:${up.port}`]);
    await expect(forwardPort(new BoxClient(gate.url, TOKEN), { remote: up.port, local: free })).rejects.toThrow(/already in use/);
  });
});

describe("forward", () => {
  it("listens on loopback only, and warns before handing over one of agentbox's own services", async () => {
    const gate = await stubTunnelGate();
    const up = await upperServer();
    cleanups.push(gate.close, up.close);
    const free = await (async () => {
      const s = net.createServer();
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const port = (s.address() as AddressInfo).port;
      await new Promise((r) => s.close(r));
      return port;
    })();
    expect(forward.options.map((o) => o.name)).not.toContain("host");
    const stdout = capture();
    const ctrlC = new AbortController();
    const running = runCli(["forward", `8080:${free}`], { configDir: signedIn(gate.url), stdout, signal: ctrlC.signal });
    const deadline = Date.now() + 5000;
    while (!stdout.text() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(stdout.text()).toContain(`http://localhost:${free}`);
    // Bound to 127.0.0.1: not on every address.
    const listeners = await new Promise<boolean>((resolve) => {
      const probe = net.connect(free, "127.0.0.1", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    expect(listeners).toBe(true);
    const outside = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (outside) {
      const reached = await new Promise<boolean>((resolve) => {
        const probe = net.connect(free, outside, () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      expect(reached, `reachable at ${outside}`).toBe(false);
    }
    ctrlC.abort();
    const r = await running;
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/port 8080 is the editor \(code-server\) in the box.*anyone on this machine.*DNS rebinding/s);
    expect(gate.targets[0]).toBe("tcp:8080");
  });
});

describe("proxy", () => {
  it("joins stdin and stdout to the box's port, printing nothing else, and ends with stdin", async () => {
    const gate = await stubTunnelGate();
    const up = await upperServer();
    cleanups.push(gate.close, up.close);
    const stdin = fakeStdin(false);
    const stdout = capture();
    const running = runCli(["proxy", `tcp:${up.port}`], { configDir: signedIn(gate.url), stdin, stdout });
    stdin.feed("ssh-2.0-hello");
    const deadline = Date.now() + 5000;
    while (!stdout.text() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    (stdin as unknown as { end(): void }).end();
    const r = await running;
    expect(r.code, r.stderr).toBe(0);
    expect(stdout.text()).toBe("SSH-2.0-HELLO");
    expect(r.stderr).toBe("");
    expect(gate.targets).toEqual([`tcp:${up.port}`]);
  });

  it("says what went wrong when the box refuses, on stderr", async () => {
    const gate = await stubTunnelGate();
    cleanups.push(gate.close);
    const r = await runCli(["proxy", "tcp:1"], { configDir: signedIn(gate.url), stdin: fakeStdin(false) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/nothing is listening on 1/);
    expect((await runCli(["proxy", "udp:53"], { configDir: signedIn(gate.url) })).code).toBe(EXIT.USAGE);
  });
});
