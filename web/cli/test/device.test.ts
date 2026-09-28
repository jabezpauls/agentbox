import fs from "node:fs";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { pollForToken, safeVerifyUrl, startDeviceLogin, type DeviceStart } from "../src/device.js";
import { CliError, EXIT } from "../src/errors.js";
import { BoxClient } from "../src/http.js";
import { VERSION } from "../src/version.js";
import { TOKEN, TOKEN2, json, runCli, signedIn, stubServer, tmpDir, type Stub } from "./helpers.js";

type Answer = { status: number; body: unknown; headers?: Record<string, string> } | "drop";

/**
 * A stand-in for the gate's device flow: start, poll (answers from `polls`, in
 * order, the last one repeating), and the calls a signed-in CLI makes.
 */
async function stubGate(
  polls: Answer[],
  opts: { interval?: number; tokens?: string[]; session?: Answer; verifyUrl?: string } = {},
): Promise<Stub & { revoked: string[] }> {
  const revoked: string[] = [];
  const valid = new Set(opts.tokens ?? [TOKEN, TOKEN2]);
  let i = 0;
  const bearer = (req: http.IncomingMessage): string | null => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
  const stub = await stubServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/_gate/device/start") {
      return json(res, 200, { deviceCode: "device-code-1", userCode: "BCDF-GHJK", verifyUrl: opts.verifyUrl ?? `${stub.url}/settings/devices?code=BCDF-GHJK`, interval: opts.interval ?? 0, expiresIn: 600 });
    }
    if (req.method === "POST" && url === "/_gate/device/poll") {
      const answer = polls[Math.min(i++, polls.length - 1)] as Answer;
      if (answer === "drop") return void req.socket.destroy();
      res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      return void res.end(JSON.stringify(answer.body));
    }
    const token = bearer(req);
    if (!token || !valid.has(token)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && url === "/_gate/session") {
      const s = opts.session;
      if (s === "drop") return void req.socket.destroy();
      if (s) return json(res, s.status, s.body);
      return json(res, 200, { kind: "token", id: token === TOKEN ? "tok-1" : "tok-2", name: "agentbox CLI on test", user: "owner", createdAt: 1000 });
    }
    if (req.method === "DELETE" && url === "/_gate/tokens/self") {
      revoked.push(token);
      valid.delete(token);
      res.writeHead(204);
      return void res.end();
    }
    if (req.method === "GET" && url === "/_gate/version") return json(res, 200, { version: VERSION });
    json(res, 404, { error: "not found" });
  });
  return Object.assign(stub, { revoked });
}

const stubs: Stub[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()?.close();
});

const START: DeviceStart = { deviceCode: "device-code-1", userCode: "BCDF-GHJK", verifyUrl: "", interval: 5, expiresIn: 600 };
const pending = { status: 400, body: { error: "authorization_pending" } };

describe("the device-flow client", () => {
  it("starts a login without the token, and checks what comes back", async () => {
    const gate = await stubGate([pending]);
    stubs.push(gate);
    const started = await startDeviceLogin(new BoxClient(gate.url, TOKEN), "laptop");
    expect(started).toMatchObject({ userCode: "BCDF-GHJK", deviceCode: "device-code-1" });
    expect(gate.seen[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(gate.seen[0]?.body.toString() ?? "{}")).toEqual({ name: "laptop" });
  });

  it("polls until approved, slowing down when told to", async () => {
    const gate = await stubGate([pending, { status: 400, body: { error: "slow_down" } }, pending, { status: 200, body: { token: TOKEN } }]);
    stubs.push(gate);
    const slept: number[] = [];
    const token = await pollForToken(new BoxClient(gate.url, null), START, { sleep: async (ms) => void slept.push(ms) });
    expect(token).toBe(TOKEN);
    expect(slept).toEqual([5000, 5000, 10_000, 10_000]);
    // The device code, and never a token, is what polling sends.
    for (const s of gate.seen) expect(s.headers.authorization).toBeUndefined();
  });

  it("says so when the owner denies it, or the code lapses", async () => {
    for (const [error, pattern] of [
      ["access_denied", /denied/],
      ["expired_token", /expired/],
      ["something_else", /refused the sign-in/],
    ] as const) {
      const gate = await stubGate([{ status: 400, body: { error } }]);
      stubs.push(gate);
      await expect(pollForToken(new BoxClient(gate.url, null), START, { sleep: async () => {} })).rejects.toThrow(pattern);
    }
  });

  it("gives up at the deadline", async () => {
    const gate = await stubGate([pending]);
    stubs.push(gate);
    let t = 0;
    const p = pollForToken(new BoxClient(gate.url, null), { ...START, expiresIn: 12 }, { sleep: async (ms) => void (t += ms), now: () => t });
    await expect(p).rejects.toThrow(/expired before it was approved/);
  });

  it("rides out a dropped connection and a rate limit", async () => {
    const gate = await stubGate(["drop", { status: 429, body: {}, headers: { "retry-after": "7" } }, { status: 200, body: { token: TOKEN } }]);
    stubs.push(gate);
    const slept: number[] = [];
    const token = await pollForToken(new BoxClient(gate.url, null), START, { sleep: async (ms) => void slept.push(ms) });
    expect(token).toBe(TOKEN);
    expect(slept).toContain(7000);
  });

  it("refuses something that is not a device token", async () => {
    const gate = await stubGate([{ status: 200, body: { token: "not-a-token" } }]);
    stubs.push(gate);
    await expect(pollForToken(new BoxClient(gate.url, null), START, { sleep: async () => {} })).rejects.toThrow(/not a device token/);
  });

  it("opens only the approval page, on the very box that was typed", () => {
    const origin = "https://box.example";
    expect(safeVerifyUrl("https://box.example/settings/devices?code=BCDF-GHJK", origin, "BCDF-GHJK")).toBe("https://box.example/settings/devices?code=BCDF-GHJK");
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://evil.example/phish",
      "https://evil.example/settings/devices?code=BCDF-GHJK",
      "http://box.example/settings/devices?code=BCDF-GHJK",
      "https://box.example:8443/settings/devices?code=BCDF-GHJK",
      "not a url",
      "https://u:p@box.example/settings/devices",
    ]) {
      expect(safeVerifyUrl(bad, origin, "BCDF-GHJK"), bad).toBe("https://box.example/settings/devices?code=BCDF-GHJK");
    }
  });

  it("waits out a box answering 5xx between restarts, longer each time", async () => {
    const gate = await stubGate([{ status: 502, body: {} }, { status: 503, body: {} }, pending, { status: 200, body: { token: TOKEN } }]);
    stubs.push(gate);
    const slept: number[] = [];
    expect(await pollForToken(new BoxClient(gate.url, null), START, { sleep: async (ms) => void slept.push(ms) })).toBe(TOKEN);
    expect(slept).toEqual([5000, 5000, 10_000, 5000]);
    const down = await stubGate([{ status: 500, body: {} }]);
    stubs.push(down);
    await expect(pollForToken(new BoxClient(down.url, null), START, { sleep: async () => {}, maxNetworkErrors: 3 })).rejects.toThrow(/kept failing.*HTTP 500/);
  });
});

describe("login, whoami and logout", () => {
  it("signs in, keeps the token in the private config only, and makes the box current", async () => {
    const gate = await stubGate([pending, { status: 200, body: { token: TOKEN } }]);
    stubs.push(gate);
    const dir = tmpDir();
    const r = await runCli(["login", gate.url, "--no-browser"], { configDir: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("BCDF-GHJK");
    expect(r.stderr).toContain(`${gate.url}/settings/devices?code=BCDF-GHJK`);
    expect(r.stdout).toMatch(/Signed in to .* as owner/);
    for (const out of [r.stdout, r.stderr]) expect(out).not.toContain(TOKEN);
    const store = new ConfigStore(dir);
    const data = store.load();
    const name = `127.0.0.1-${gate.port}`;
    expect(data.current).toBe(name);
    expect(data.boxes[name]).toMatchObject({ url: gate.url, token: TOKEN, tokenId: "tok-1", user: "owner", device: "agentbox CLI on test" });
    if (process.platform !== "win32") expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it("revokes the token it replaces when signing in again", async () => {
    const gate = await stubGate([{ status: 200, body: { token: TOKEN2 } }]);
    stubs.push(gate);
    const dir = signedIn(gate.url);
    const r = await runCli(["login", gate.url, "--no-browser", "--name", "test"], { configDir: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(new ConfigStore(dir).load().boxes.test?.token).toBe(TOKEN2);
    expect(gate.revoked).toEqual([TOKEN]);
  });

  it("points the browser only at the typed box, whatever the box names", async () => {
    const gate = await stubGate([{ status: 200, body: { token: TOKEN } }], { verifyUrl: "https://evil.example/settings/devices?code=BCDF-GHJK" });
    stubs.push(gate);
    const r = await runCli(["login", gate.url, "--no-browser"], { configDir: tmpDir() });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain(`${gate.url}/settings/devices?code=BCDF-GHJK`);
    expect(r.stderr).not.toContain("evil.example");
  });

  it("revokes the new token when checking it fails, and keeps nothing", async () => {
    for (const session of [{ status: 500, body: { error: "boom" } }, { status: 200, body: { unexpected: true } }] as Answer[]) {
      const gate = await stubGate([{ status: 200, body: { token: TOKEN } }], { session });
      stubs.push(gate);
      const dir = tmpDir();
      const r = await runCli(["login", gate.url, "--no-browser"], { configDir: dir });
      expect(r.code).toBe(EXIT.FAILURE);
      expect(gate.revoked).toEqual([TOKEN]);
      expect(new ConfigStore(dir).load().boxes).toEqual({});
    }
  });

  it("replaces the same box saved under another name, revoking its token", async () => {
    const gate = await stubGate([{ status: 200, body: { token: TOKEN2 } }]);
    stubs.push(gate);
    const dir = signedIn(gate.url);
    const r = await runCli(["login", gate.url, "--no-browser", "--name", "work"], { configDir: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Replaced the box saved as "test"/);
    const data = new ConfigStore(dir).load();
    expect(Object.keys(data.boxes)).toEqual(["work"]);
    expect(data.boxes.work?.token).toBe(TOKEN2);
    expect(data.current).toBe("work");
    expect(gate.revoked).toEqual([TOKEN]);
  });

  it("will not reuse a name that belongs to another box", async () => {
    const gate = await stubGate([pending]);
    stubs.push(gate);
    const dir = signedIn("https://elsewhere.example");
    const r = await runCli(["login", gate.url, "--name", "test", "--no-browser"], { configDir: dir });
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.stderr).toMatch(/already https:\/\/elsewhere\.example/);
  });

  it("says who this is, without the token", async () => {
    const gate = await stubGate([pending]);
    stubs.push(gate);
    const dir = signedIn(gate.url);
    const r = await runCli(["whoami", "--json"], { configDir: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ box: "test", url: gate.url, user: "owner", device: "agentbox CLI on test", tokenId: "tok-1", boxVersion: VERSION });
    expect(r.stdout).not.toContain(TOKEN);
    const human = await runCli(["whoami"], { configDir: dir });
    expect(human.stdout).toMatch(/^owner on test/);
  });

  it("logs out by revoking its own token, then forgets the box", async () => {
    const gate = await stubGate([pending]);
    stubs.push(gate);
    const dir = signedIn(gate.url);
    const r = await runCli(["logout"], { configDir: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(gate.revoked).toEqual([TOKEN]);
    expect(new ConfigStore(dir).load()).toEqual({ version: 1, current: null, boxes: {} });
    // Afterwards the token no longer works, and the CLI says to sign in.
    const again = await runCli(["whoami"], { configDir: dir });
    expect(again.code).toBe(EXIT.AUTH);
  });

  it("forgets a box whose token was already revoked", async () => {
    const gate = await stubGate([pending], { tokens: [] });
    stubs.push(gate);
    const dir = signedIn(gate.url);
    const r = await runCli(["logout"], { configDir: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/already been revoked/);
    expect(new ConfigStore(dir).load().boxes).toEqual({});
  });

  it("keeps the box when it cannot be reached, unless told --local", async () => {
    const gate = await stubGate([pending]);
    const url = gate.url;
    await gate.close();
    const dir = signedIn(url);
    const r = await runCli(["logout"], { configDir: dir });
    expect(r.code).toBe(EXIT.UNREACHABLE);
    expect(r.stderr).toMatch(/--local/);
    expect(new ConfigStore(dir).load().boxes.test).toBeDefined();
    const local = await runCli(["logout", "--local"], { configDir: dir });
    expect(local.code).toBe(0);
    expect(local.stdout).toMatch(/still valid/);
    expect(new ConfigStore(dir).load().boxes.test).toBeUndefined();
  });

  it("reports a refused token as exit 3 and an unreachable box as exit 5", async () => {
    const gate = await stubGate([pending], { tokens: [] });
    stubs.push(gate);
    const refused = await runCli(["whoami"], { configDir: signedIn(gate.url) });
    expect(refused.code).toBe(EXIT.AUTH);
    expect(refused.stderr).toMatch(/agentbox login/);
    const down = await runCli(["whoami"], { configDir: signedIn("http://127.0.0.1:1") });
    expect(down.code).toBe(EXIT.UNREACHABLE);
    expect(down.stderr).toMatch(/could not reach http:\/\/127\.0\.0\.1:1/);
    const none = await runCli(["whoami"], { configDir: tmpDir() });
    expect(none.code).toBe(EXIT.AUTH);
  });
});

describe("CliError", () => {
  it("carries its exit code", () => {
    expect(new CliError("x", EXIT.NOT_FOUND).exitCode).toBe(4);
  });
});
