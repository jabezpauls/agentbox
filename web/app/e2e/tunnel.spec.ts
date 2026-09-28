import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
// The CLI's own tunnel client, against the real gate and bridge: the
// protocol is theirs to agree on, so this is the one to test with.
import { BoxClient } from "../../cli/src/http.ts";
import { forwardPort, openTunnel, TunnelError } from "../../cli/src/tunnel.ts";
import { GATE, PASSWORD, gateApi, signIn } from "./gate.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let server: ChildProcess | null = null;
let dir = "";
let port = 0;

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-tunnel-"));
  fs.writeFileSync(path.join(dir, "hello.txt"), "through the tunnel\n");
  port = await freePort();
  server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: dir, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the CLI's tunnels reach a port and herdr, with a device token and nothing else", async ({ page }) => {
  // A device token, the way `agentbox login` gets one.
  await signIn(page);
  const start = await gateApi(page, "POST", "/_gate/device/start", { name: "tunnel e2e" });
  const { deviceCode, userCode } = start.body as { deviceCode: string; userCode: string };
  expect((await gateApi(page, "POST", "/_gate/device/approve", { userCode, password: PASSWORD })).status).toBe(200);
  const poll = await gateApi(page, "POST", "/_gate/device/poll", { deviceCode });
  const token = String(poll.body.token);
  expect(token).toMatch(/^abx_/);
  const client = new BoxClient(GATE, token);

  await test.step("forward: a local port that is the remote server", async () => {
    const local = await freePort();
    const listener = await forwardPort(client, { remote: port, local });
    try {
      const res = await fetch(`http://127.0.0.1:${local}/hello.txt`);
      expect(await res.text()).toBe("through the tunnel\n");
    } finally {
      listener.close();
    }
  });

  await test.step("herdr: its socket's protocol, end to end", async () => {
    const tunnel = await openTunnel(client, { kind: "herdr" });
    const reply = new Promise<string>((resolve) => {
      let text = "";
      tunnel.on("data", (d: Buffer) => {
        text += d.toString("utf8");
        if (text.includes("\n")) resolve(text.split("\n")[0] as string);
      });
    });
    tunnel.write(`${JSON.stringify({ id: "e2e", method: "ping", params: {} })}\n`);
    expect(JSON.parse(await reply)).toMatchObject({ id: "e2e" });
    tunnel.destroy();
  });

  await test.step("a port nothing listens on: the box says why", async () => {
    const closed = await freePort();
    const tunnel = await openTunnel(client, { kind: "tcp", port: closed }).catch((err: Error) => err);
    const err =
      tunnel instanceof Error
        ? tunnel
        : await new Promise<Error>((resolve) => {
            tunnel.once("error", resolve);
            tunnel.resume();
          });
    expect(err).toBeInstanceOf(TunnelError);
    expect(err.message).toContain(`port ${closed}`);
  });

  await test.step("no token, or a revoked one: refused", async () => {
    await expect(openTunnel(new BoxClient(GATE, null), { kind: "tcp", port })).rejects.toThrow();
    const res = await fetch(`${GATE}/_gate/tokens/self`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(204);
    await expect(openTunnel(client, { kind: "tcp", port })).rejects.toThrow();
  });
});
