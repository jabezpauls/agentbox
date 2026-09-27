import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { filesFixture, type FilesFixture } from "./helpers/files.js";
import { findFd, searchNames } from "../src/files/search.js";

// Uploads over a real socket: what inject cannot show is a body that arrives
// in pieces, without a length, or not at all.
let f: FilesFixture;
let port: number;

beforeAll(async () => {
  f = await filesFixture({ maxChunk: 64 * 1024 });
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  port = (f.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await f.close();
});

async function json(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("uploads over the network", () => {
  it("takes a chunk sent without a length or a content type", async () => {
    const start = await json("POST", "/api/files/uploads", { path: "streamed.bin", size: 6 });
    const id = start.body.uploadId as string;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/api/files/uploads/${id}?offset=0` }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      // No content-length: node sends this chunked.
      req.write("abc");
      setTimeout(() => req.end("def"), 20);
    });
    expect(status).toBe(200);
    expect((await json("POST", `/api/files/uploads/${id}/finish`)).status).toBe(200);
    expect(fs.readFileSync(path.join(f.workspace, "streamed.bin"), "utf8")).toBe("abcdef");
  });

  it("keeps nothing of a chunk cut off mid-flight, and takes the retry", async () => {
    const data = Buffer.alloc(64 * 1024, 7);
    const start = await json("POST", "/api/files/uploads", { path: "cut.bin", size: data.length });
    const id = start.body.uploadId as string;
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "PUT",
        path: `/api/files/uploads/${id}?offset=0`,
        headers: { "content-length": String(data.length), "content-type": "application/octet-stream" },
      });
      req.on("error", () => resolve());
      req.write(data.subarray(0, 1000));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    // Give the server a moment to notice the aborted body.
    await new Promise((r) => setTimeout(r, 100));
    expect((await json("GET", `/api/files/uploads/${id}`)).body.received).toBe(0);

    const res = await fetch(`http://127.0.0.1:${port}/api/files/uploads/${id}?offset=0`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: data,
    });
    expect(res.status).toBe(200);
    expect((await json("POST", `/api/files/uploads/${id}/finish`)).status).toBe(200);
    expect(fs.readFileSync(path.join(f.workspace, "cut.bin")).equals(data)).toBe(true);
  });

  it("refuses an oversized chunk by its declared length before reading it", async () => {
    const start = await json("POST", "/api/files/uploads", { path: "huge.bin", size: 10 * 1024 * 1024 });
    const id = start.body.uploadId as string;
    const res = await fetch(`http://127.0.0.1:${port}/api/files/uploads/${id}?offset=0`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(64 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});

describe("name search", () => {
  const engines: [string, string | null][] = [["the built-in walker", null]];
  const fd = findFd();
  if (fd) engines.push([`fd (${path.basename(fd)})`, fd]);

  for (const [label, bin] of engines) {
    it(`finds names best-first with ${label}`, async () => {
      const d = path.join(f.workspace, `search-${bin ? "fd" : "walk"}`);
      fs.mkdirSync(path.join(d, "deep", "er"), { recursive: true });
      fs.writeFileSync(path.join(d, "deep", "er", "Widget.ts"), "");
      fs.writeFileSync(path.join(d, "widget.ts"), "");
      fs.writeFileSync(path.join(d, "my-widget-helper.ts"), "");
      fs.mkdirSync(path.join(d, "node_modules", "widget"), { recursive: true });
      fs.mkdirSync(path.join(d, ".agentbox", "trash", "widget"), { recursive: true });
      const found = await searchNames({ dir: d, query: "widget", limit: 10, fd: bin });
      expect(found.map((p) => path.relative(d, p))).toEqual(["widget.ts", "deep/er/Widget.ts", "my-widget-helper.ts"]);
      // A query with a slash matches on the path.
      const byPath = await searchNames({ dir: d, query: "er/wid", limit: 10, fd: bin });
      expect(byPath.map((p) => path.relative(d, p))).toEqual(["deep/er/Widget.ts"]);
    });
  }
});
