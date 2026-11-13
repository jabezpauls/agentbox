import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  BudgetExceeded,
  decodeFrame,
  decodeOpen,
  encodeFrame,
  encodeOpen,
  FrameType,
  STREAM_WINDOW,
  StreamBudget,
  StreamTable,
  type LinkStream,
} from "../src/link/index.js";

/** Two ends of a link, in memory. */
function pair(window = STREAM_WINDOW) {
  const sent = { dataToB: 0 };
  const ends: { a?: StreamTable; b?: StreamTable } = {};
  ends.a = new StreamTable((f) => {
    const frame = decodeFrame(f);
    if (frame.type === FrameType.data) sent.dataToB += frame.payload.length;
    setImmediate(() => ends.b?.receive(frame));
  }, window);
  ends.b = new StreamTable((f) => {
    const frame = decodeFrame(f);
    setImmediate(() => ends.a?.receive(frame));
  }, window);
  return { a: ends.a, b: ends.b, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function readAll(s: LinkStream): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    s.on("data", (c: Buffer) => chunks.push(c));
    s.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("link streams", () => {
  it("carries bytes both ways, then ends both ways on close", async () => {
    const { a, b } = pair();
    const x = a.open(7);
    const y = b.open(7);
    const got = readAll(y);
    const back = readAll(x);
    const big = Buffer.alloc(3 * STREAM_WINDOW + 123, 0x61);
    x.write(big);
    y.write("pong");
    await tick();
    x.end();
    expect((await got).equals(big)).toBe(true);
    expect((await back).toString()).toBe("pong");
    await tick();
    expect(a.size).toBe(0);
    expect(b.size).toBe(0);
  });

  it("stops at the window while the reader does not read, and goes on when it does", async () => {
    const window = 64 * 1024;
    const { a, b, sent } = pair(window);
    const x = a.open(1);
    const y = b.open(1);
    y.pause();
    let done = false;
    x.write(Buffer.alloc(window * 5), () => (done = true));
    await tick();
    await tick();
    // What arrived is bounded by the window (plus the reader's own small buffer).
    expect(sent.dataToB).toBeLessThanOrEqual(window * 2);
    expect(done).toBe(false);
    let n = 0;
    y.on("data", (c: Buffer) => (n += c.length));
    y.resume();
    for (let i = 0; i < 50 && !done; i++) await tick();
    expect(done).toBe(true);
    expect(n).toBe(window * 5);
  });

  it("ends a stream whose far end sends past its window", async () => {
    const t = new StreamTable(() => {});
    const s = t.open(3);
    s.pause();
    const closed = new Promise((r) => s.once("close", r));
    for (let i = 0; i < 5; i++) t.receive(decodeFrame(encodeFrame(FrameType.data, 3, Buffer.alloc(64 * 1024))));
    await closed;
    expect(s.destroyed).toBe(true);
    expect(t.size).toBe(0);
  });

  it("drops writes after the far end closed, and does not answer its close", async () => {
    const frames: number[] = [];
    const t = new StreamTable((f) => frames.push(decodeFrame(f).type));
    const s = t.open(9);
    s.resume();
    t.receive(decodeFrame(encodeFrame(FrameType.close, 9)));
    s.write("late");
    await new Promise((r) => s.once("close", r));
    expect(frames).toHaveLength(0);
    expect(t.receive(decodeFrame(encodeFrame(FrameType.data, 9, Buffer.from("x"))))).toBe(false);
  });

  it("ends every stream when the link ends", async () => {
    const t = new StreamTable(() => {});
    const s = [t.open(1), t.open(2)];
    const closes = s.map((x) => new Promise((r) => x.once("close", r)));
    t.endAll("machine offline");
    await Promise.all(closes);
    expect(t.size).toBe(0);
  });

  it("carries an HTTP exchange from a client to a server that listens on nothing", async () => {
    const { a, b } = pair();
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        res.end(`${req.method} ${req.url} ${body.length}`);
      });
    });
    let id = 0;
    const answer = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          path: "/api/rpc",
          headers: { host: "machine" },
          createConnection: (_o: unknown, cb: (err: Error | null, s: LinkStream) => void) => {
            id += 1;
            const near = a.open(id);
            server.emit("connection", b.open(id));
            cb(null, near);
            return undefined;
          },
        } as http.RequestOptions,
        (res) => {
          let t = "";
          res.on("data", (c: Buffer) => (t += c.toString()));
          res.on("end", () => resolve(`${res.statusCode} ${t}`));
        },
      );
      req.on("error", reject);
      req.end("x".repeat(300_000));
    });
    expect(answer).toBe("200 POST /api/rpc 300000");
    for (let i = 0; i < 20 && (a.size || b.size); i++) await tick();
    expect(a.size + b.size).toBe(0);
  });

  it("reads an open frame's payload, claiming nothing when it is broken", () => {
    expect(decodeOpen(encodeOpen({ kind: "upgrade", session: "s1", grant: "g_1" }))).toEqual({ kind: "upgrade", session: "s1", grant: "g_1" });
    expect(decodeOpen(Buffer.from("{nope"))).toEqual({ kind: "http", session: null, grant: null });
    expect(decodeOpen(Buffer.from(JSON.stringify({ session: "a b", grant: 5 })))).toEqual({ kind: "http", session: null, grant: null });
    // An app's port, when it is one; never anything else.
    expect(decodeOpen(encodeOpen({ kind: "http", session: null, grant: null, app: 3000 })).app).toBe(3000);
    for (const app of [0, 70000, 3.5, "3000", null]) expect(decodeOpen(Buffer.from(JSON.stringify({ app }))).app).toBeUndefined();
  });
});

describe("the stream budget", () => {
  it("queues past the total, first come first served, and refuses after the wait", async () => {
    const budget = new StreamBudget(100, 60);
    const r1 = await budget.reserve(60);
    const order: string[] = [];
    const second = budget.reserve(60).then((r) => {
      order.push("second");
      return r;
    });
    const third = budget.reserve(30).then((r) => {
      order.push("third");
      return r;
    });
    expect(budget.waiting).toBe(2);
    r1();
    r1(); // given back once only
    const r2 = await second;
    const r3 = await third;
    expect(order).toEqual(["second", "third"]);
    expect(budget.inUse).toBe(90);
    await expect(budget.reserve(20)).rejects.toBeInstanceOf(BudgetExceeded);
    r2();
    r3();
    expect(budget.inUse).toBe(0);
  });
});
