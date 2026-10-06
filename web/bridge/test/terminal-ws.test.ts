import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { SessionHub } from "../src/herdr/session.js";
import { TerminalStreams } from "../src/herdr/terminal.js";
import { loadConfig, type Config } from "../src/config.js";
import { request } from "../src/herdr/socket.js";
import { startTestHerdr, TestHerdr } from "./helpers/herdr.js";

let h: TestHerdr;
let hub: SessionHub;
let streams: TerminalStreams;
let app: FastifyInstance;
let baseUrl: string;

async function newPane(label: string): Promise<string> {
  const created = await request<{ root_pane: { pane_id: string } }>(h.socketPath, "workspace.create", {
    cwd: h.dir,
    label,
  });
  return created.root_pane.pane_id;
}

beforeAll(async () => {
  h = await startTestHerdr();
  const config: Config = loadConfig({
    HERDR_SOCKET_PATH: h.socketPath,
    WORKBENCH_PORT: "0",
    WORKBENCH_STATIC_DIR: "/does/not/exist-workbench-static",
  });
  hub = new SessionHub(config.socketPath);
  await hub.start();
  streams = new TerminalStreams(h.env);
  app = await buildApp(config, { hub, streams });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `127.0.0.1:${port}`;
}, 25_000);

afterAll(async () => {
  await app.close();
  hub.stop();
  await h.stop();
});

function open(pane: string): WebSocket {
  return new WebSocket(`ws://${baseUrl}/ws/terminal?pane=${pane}&cols=80&rows=24`, {
    origin: `http://${baseUrl}`,
  });
}

describe("terminal ws route", () => {
  it("streams binary frames and echoes JSON input", async () => {
    const pane = await newPane("ws-echo");
    const ws = open(pane);
    const binary: Buffer[] = [];
    ws.on("message", (raw, isBinary) => {
      if (isBinary) binary.push(raw as Buffer);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no binary frame")), 3_000);
      const check = setInterval(() => {
        if (binary.length > 0) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
    });
    expect(binary.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "input", text: "echo WS_$((5*8))\n" }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no echo")), 5_000);
      const check = setInterval(() => {
        if (Buffer.concat(binary).toString("utf8").includes("WS_40")) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
    });
    expect(Buffer.concat(binary).toString("utf8")).toContain("WS_40");

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("carries several panes on one shared socket, each on its own channel", async () => {
    const a = await newPane("mux-a");
    const b = await newPane("mux-b");
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { origin: `http://${baseUrl}` });
    const out = new Map<number, string>();
    const notices: Array<{ type: string; ch: number; reason?: string }> = [];
    ws.on("message", (raw, isBinary) => {
      const buf = raw as Buffer;
      if (!isBinary) return void notices.push(JSON.parse(buf.toString()));
      const ch = buf.readUInt16BE(0);
      out.set(ch, (out.get(ch) ?? "") + buf.subarray(2).toString("utf8"));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const send = (m: object) => ws.send(JSON.stringify(m));
    // A ping is answered at once, on any channel, attached or not.
    send({ ch: 0, type: "ping", t: 1234.5 });
    // Before an attach, a channel is nothing: its input goes nowhere.
    send({ ch: 1, type: "input", text: "echo NOPE\n" });
    send({ ch: 1, type: "attach", pane: a, cols: 80, rows: 24 });
    send({ ch: 300, type: "attach", pane: b, cols: 80, rows: 24 });
    send({ ch: 1, type: "input", text: "echo MUX_A_$((2*21))\n" });
    send({ ch: 300, type: "input", text: "echo MUX_B_$((3*14))\n" });
    const until = async (ok: () => boolean, what: string) => {
      const t0 = Date.now();
      while (!ok()) {
        if (Date.now() - t0 > 5_000) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(() => (out.get(1) ?? "").includes("MUX_A_42") && (out.get(300) ?? "").includes("MUX_B_42"), "both echoes");
    expect(out.get(1)).not.toContain("MUX_B_42");
    expect(out.get(300)).not.toContain("MUX_A_42");
    expect(notices).toContainEqual({ type: "pong", ch: 0, t: 1234.5 });

    // A bad pane is refused on its channel alone; the socket stays up.
    send({ ch: 7, type: "attach", pane: "../etc", cols: 80, rows: 24 });
    await until(() => notices.some((n) => n.ch === 7 && n.type === "closed"), "a refusal");
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Detached, a channel hears nothing more; the other carries on.
    send({ ch: 1, type: "detach" });
    await new Promise((r) => setTimeout(r, 200));
    const before = out.get(1) ?? "";
    send({ ch: 1, type: "input", text: "echo GONE\n" });
    send({ ch: 300, type: "input", text: "echo STILL_$((6*7))\n" });
    await until(() => (out.get(300) ?? "").includes("STILL_42"), "the other channel");
    expect(out.get(1) ?? "").toBe(before);

    // A pane that exits says so on its channel, and the socket stays open.
    send({ ch: 300, type: "input", text: "exit\n" });
    await until(() => notices.some((n) => n.ch === 300 && n.type === "closed"), "the pane's end");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("attaches to the panes of a tenth workspace and beyond, whose ids have letters", async () => {
    // herdr counts in base 36, so past w9 come wA, wB…
    let pane = "";
    for (let i = 0; i < 12 && !/^w[0-9]*[A-Za-z]/.test(pane); i++) pane = await newPane(`ws-many-${i}`);
    expect(pane).toMatch(/^w[0-9]*[A-Za-z]/);
    const ws = open(pane);
    const out: Buffer[] = [];
    ws.on("message", (raw, isBinary) => {
      if (isBinary) out.push(raw as Buffer);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "input", text: "echo LETTERS_$((6*7))\n" }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no echo from ${pane}`)), 5_000);
      const check = setInterval(() => {
        if (Buffer.concat(out).toString("utf8").includes("LETTERS_42")) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
    });
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("rejects an invalid pane id with close code 1008", async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal?pane=not-a-pane&cols=80&rows=24`, {
      origin: `http://${baseUrl}`,
    });
    const code = await new Promise<number>((resolve, reject) => {
      ws.once("close", (c) => resolve(c));
      ws.once("error", reject);
    });
    expect(code).toBe(1008);
  });

  it("sends a closed notice when the pane exits", async () => {
    const pane = await newPane("ws-close");
    const ws = open(pane);
    const json: Array<{ type: string; reason?: string }> = [];
    ws.on("message", (raw, isBinary) => {
      if (!isBinary) json.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // Wait for the first frame so the shell prompt is ready before we exit it.
    await new Promise((r) => setTimeout(r, 1_200));

    ws.send(JSON.stringify({ type: "input", text: "exit\n" }));

    const closed = await new Promise<{ type: string; reason?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no closed notice")), 5_000);
      const check = setInterval(() => {
        const m = json.find((x) => x.type === "closed");
        if (m) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(m);
        }
      }, 25);
    });
    expect(closed.type).toBe("closed");
    expect(typeof closed.reason).toBe("string");

    await new Promise<void>((resolve) => {
      if (ws.readyState === ws.CLOSED) resolve();
      else ws.once("close", () => resolve());
    });
  });
});
