import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { request } from "@workbench/hostcore/herdr";
import { HerdrSupervisor } from "../src/node/herdr.js";
import { tmpDir } from "./helpers.js";

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const f = path.join(dir, cmd);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const herdr = which("herdr");

function next<T extends unknown[]>(s: HerdrSupervisor, event: string): Promise<T> {
  return new Promise((r) => s.once(event, (...a: unknown[]) => r(a as T)));
}

// A real herdr (CI installs the pinned one), in a home of its own.
describe.skipIf(!herdr)("the node's herdr", () => {
  it("runs in its own session on a fresh socket, restarts when it dies, and is adopted by the next node", async () => {
    const home = tmpDir("abh-");
    const dir = path.join(home, "node");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".state") };
    const s = new HerdrSupervisor({ bin: herdr as string, dir, env, checkMs: 100 });
    const ready = next<[string, { restored: boolean }]>(s, "ready");
    await s.start();
    const [first, info] = await ready;
    expect(info.restored).toBe(true);
    expect(path.basename(first)).toMatch(/^herdr-[0-9a-f]{8}\.sock$/);
    // Its own session's state, apart from the owner's own herdr.
    expect(fs.existsSync(path.join(home, ".config", "herdr", "sessions", "agentbox-node"))).toBe(true);
    expect(await s.idle()).toBe(true);

    // Killed: restarted, on a new socket.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state", "herdr.json"), "utf8")) as { pid: number; socket: string };
    expect(saved.socket).toBe(first);
    const again = next<[string]>(s, "ready");
    process.kill(saved.pid, "SIGKILL");
    const [second] = await again;
    expect(second).not.toBe(first);
    await request(second, "ping");
    s.stop();

    // The next node keeps the running server.
    const t = new HerdrSupervisor({ bin: herdr as string, dir, env });
    const adopted = next<[string, { restored: boolean }]>(t, "ready");
    await t.start();
    expect(await adopted).toEqual([second, { restored: false }]);
    t.stop(true);
  }, 30_000);
});
