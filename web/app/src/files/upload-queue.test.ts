import { describe, expect, it, vi } from "vitest";
import { summarise, UploadQueue, type TransportError, type UploadTransport } from "./upload-queue.ts";

/** A server in memory: sessions, received bytes, files that exist. */
class FakeServer implements UploadTransport {
  sessions = new Map<string, { path: string; size: number; received: number; overwrite: boolean }>();
  files = new Map<string, number>();
  dirs: string[] = [];
  cancelled: string[] = [];
  /** Throw on the nth put (1-based), as a network failure. */
  failPuts = new Set<number>();
  /** Accept the nth put's bytes, then fail as if the answer was lost. */
  loseAnswers = new Set<number>();
  puts = 0;
  private n = 0;

  async start(path: string, size: number, overwrite: boolean) {
    if (this.files.has(path) && !overwrite) throw err(409, "exists");
    const uploadId = `up${++this.n}`;
    this.sessions.set(uploadId, { path, size, received: 0, overwrite });
    return { uploadId };
  }
  async put(id: string, offset: number, chunk: Blob, onProgress: (n: number) => void) {
    this.puts++;
    const s = this.sessions.get(id)!;
    if (this.failPuts.has(this.puts)) throw err(0, undefined, "network");
    if (offset > s.received) throw err(409, `offset:${s.received}`);
    onProgress(chunk.size);
    s.received = Math.max(s.received, offset + chunk.size);
    if (this.loseAnswers.has(this.puts)) throw err(0, undefined, "network");
    return { received: s.received };
  }
  async status(id: string) {
    return { received: this.sessions.get(id)!.received };
  }
  async finish(id: string) {
    const s = this.sessions.get(id)!;
    if (s.received !== s.size) throw err(409, `offset:${s.received}`);
    this.files.set(s.path, s.size);
  }
  async cancel(id: string) {
    this.cancelled.push(id);
    this.sessions.delete(id);
  }
  async mkdir(path: string) {
    this.dirs.push(path);
  }
}

function err(status: number, code?: string, message = "refused"): TransportError {
  return { status, code, message };
}

const blob = (n: number) => new Blob([new Uint8Array(n)]);

async function settle(q: UploadQueue) {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (!q.items.some((x) => ["queued", "uploading", "finishing"].includes(x.state))) return;
  }
}

const quick = { chunkSize: 10, sleep: async () => {}, backoff: () => 0 };

describe("UploadQueue", () => {
  it("sends a file in chunks and finishes it", async () => {
    const server = new FakeServer();
    const q = new UploadQueue(server, quick);
    const done = vi.fn();
    q.onComplete(done);
    q.add([{ file: blob(25), dest: "/w/a.bin" }]);
    await settle(q);
    expect(server.files.get("/w/a.bin")).toBe(25);
    expect(server.puts).toBe(3);
    expect(q.items[0]).toMatchObject({ state: "done", sent: 25 });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("finishes an empty file without sending a chunk", async () => {
    const server = new FakeServer();
    const q = new UploadQueue(server, quick);
    q.add([{ file: blob(0), dest: "/w/empty" }]);
    await settle(q);
    expect(server.files.get("/w/empty")).toBe(0);
    expect(server.puts).toBe(0);
  });

  it("retries a chunk the network dropped, from where the server is", async () => {
    const server = new FakeServer();
    server.failPuts.add(2);
    const q = new UploadQueue(server, quick);
    q.add([{ file: blob(30), dest: "/w/a" }]);
    await settle(q);
    expect(q.items[0]!.state).toBe("done");
    expect(server.files.get("/w/a")).toBe(30);
  });

  it("does not resend a chunk the server took when only the answer was lost", async () => {
    const server = new FakeServer();
    server.loseAnswers.add(1);
    const q = new UploadQueue(server, quick);
    q.add([{ file: blob(20), dest: "/w/a" }]);
    await settle(q);
    expect(q.items[0]!.state).toBe("done");
    // Chunk 1 (lost answer), then chunk 2 from offset 10 — status said 10.
    expect(server.puts).toBe(2);
  });

  it("gives up after enough failures and says so", async () => {
    const server = new FakeServer();
    for (let i = 1; i < 20; i++) server.failPuts.add(i);
    const q = new UploadQueue(server, { ...quick, retries: 2 });
    q.add([{ file: blob(5), dest: "/w/a" }]);
    await settle(q);
    expect(q.items[0]).toMatchObject({ state: "error", error: "network" });
    q.retry(q.items[0]!.id);
    server.failPuts.clear();
    await settle(q);
    expect(q.items[0]!.state).toBe("done");
  });

  it("pauses on a name that is taken, then replaces, keeps both or skips", async () => {
    const server = new FakeServer();
    server.files.set("/w/a.txt", 1);
    server.files.set("/w/b.txt", 1);
    server.files.set("/w/b (2).txt", 1);
    server.files.set("/w/c.txt", 1);
    const q = new UploadQueue(server, quick);
    q.add([
      { file: blob(3), dest: "/w/a.txt" },
      { file: blob(3), dest: "/w/b.txt" },
      { file: blob(3), dest: "/w/c.txt" },
    ]);
    await settle(q);
    expect(q.items.map((i) => i.state)).toEqual(["conflict", "conflict", "conflict"]);
    expect(summarise(q.items).conflicts).toBe(3);

    const [a, b, c] = q.items;
    q.resolve(a!.id, "replace");
    q.resolve(b!.id, "rename");
    q.resolve(c!.id, "skip");
    await settle(q);
    expect(server.files.get("/w/a.txt")).toBe(3);
    expect(server.files.get("/w/b (3).txt")).toBe(3);
    expect(q.items[1]!.name).toBe("b (3).txt");
    expect(server.files.get("/w/c.txt")).toBe(1);
    expect(q.items[2]!.state).toBe("skipped");
  });

  it("cancels a file and throws its session away", async () => {
    const server = new FakeServer();
    const q = new UploadQueue(server, { ...quick, concurrency: 1 });
    q.add([
      { file: blob(10), dest: "/w/one" },
      { file: blob(10), dest: "/w/two" },
    ]);
    q.cancel(q.items[1]!.id);
    await settle(q);
    expect(q.items.map((i) => i.state)).toEqual(["done", "cancelled"]);
    expect(server.files.has("/w/two")).toBe(false);
    expect(summarise(q.items)).toMatchObject({ files: 1, done: 1 });
    q.clearFinished();
    expect(q.items).toHaveLength(0);
  });

  it("makes empty folders from a dropped tree", async () => {
    const server = new FakeServer();
    const q = new UploadQueue(server, quick);
    q.add([], ["/w/tree/empty"]);
    await settle(q);
    expect(server.dirs).toEqual(["/w/tree/empty"]);
  });

  it("runs a few files at once, not all", async () => {
    let inFlight = 0;
    let peak = 0;
    const server = new FakeServer();
    const put = server.put.bind(server);
    server.put = async (...args) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return put(...args);
    };
    const q = new UploadQueue(server, { ...quick, concurrency: 2 });
    q.add(Array.from({ length: 6 }, (_, i) => ({ file: blob(5), dest: `/w/${i}` })));
    for (let i = 0; i < 200 && q.items.some((x) => x.state !== "done"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(peak).toBe(2);
    expect(q.items.every((i) => i.state === "done")).toBe(true);
  });
});
