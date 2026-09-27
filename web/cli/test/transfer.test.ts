import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, CliError, EXIT } from "../src/errors.js";
import { encodePathParam, FilesApi, joinRemote, remoteBase } from "../src/files-api.js";
import { BoxClient } from "../src/http.js";
import { downloadFile, resumeOffset, ResumeStore, uploadFile } from "../src/transfer.js";
import { filesStub, put, type FilesStub } from "./files-stub.js";
import { TOKEN, tmpDir } from "./helpers.js";

const stubs: FilesStub[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()?.close();
});

async function setup(): Promise<{ stub: FilesStub; api: FilesApi; dir: string }> {
  const stub = await filesStub();
  stubs.push(stub);
  return { stub, api: new FilesApi(new BoxClient(stub.url, TOKEN)), dir: tmpDir() };
}

function localFile(dir: string, size: number): { file: string; data: Buffer } {
  const data = randomBytes(size);
  const file = path.join(dir, `data-${size}.bin`);
  fs.writeFileSync(file, data);
  return { file, data };
}

const noSleep = async (): Promise<void> => {};

describe("paths on the box", () => {
  it("are sent byte for byte, stray bytes included", () => {
    expect(encodePathParam("/workspace/a b&c")).toBe("%2Fworkspace%2Fa%20b%26c");
    expect(encodePathParam("/w/café")).toBe("%2Fw%2Fcaf%C3%A9");
    // A name that is not UTF-8 travels as U+DC80 + byte, and goes back as that byte.
    expect(encodePathParam("/w/\udcff\udc80")).toBe("%2Fw%2F%FF%80");
    expect(joinRemote("/workspace/", "x")).toBe("/workspace/x");
    expect(remoteBase("/workspace/proj/")).toBe("proj");
  });
});

describe("chunked uploads", () => {
  it("sends a file in chunks at increasing offsets and finishes it", async () => {
    const { stub, api, dir } = await setup();
    const { file, data } = localFile(dir, 10_000);
    const progress: number[] = [];
    const entry = await uploadFile({ api, file, remote: "/workspace/big.bin", overwrite: false, chunkSize: 4096, onProgress: (n) => progress.push(n) });
    expect(entry.path).toBe("/workspace/big.bin");
    expect(stub.fs.get("/workspace/big.bin")?.data.equals(data)).toBe(true);
    const puts = stub.seen.filter((s) => s.method === "PUT");
    expect(puts.map((s) => new URL(s.url, "http://x").searchParams.get("offset"))).toEqual(["0", "4096", "8192"]);
    expect(puts.map((s) => s.headers["content-length"])).toEqual(["4096", "4096", "1808"]);
    expect(progress.at(-1)).toBe(10_000);
  });

  it("uploads an empty file", async () => {
    const { stub, api, dir } = await setup();
    const { file } = localFile(dir, 0);
    await uploadFile({ api, file, remote: "/workspace/empty", overwrite: false });
    expect(stub.fs.get("/workspace/empty")?.data.length).toBe(0);
    expect(stub.seen.filter((s) => s.method === "PUT")).toHaveLength(0);
  });

  it("asks the box how much arrived after a dropped connection, and goes on from there", async () => {
    const { stub, api, dir } = await setup();
    const { file, data } = localFile(dir, 10_000);
    // The second chunk's connection drops before the box takes it; the third
    // is taken but its answer is lost.
    stub.chunkHook = (n) => (n === 1 ? "drop" : n === 3 ? "lost" : undefined);
    await uploadFile({ api, file, remote: "/workspace/big.bin", overwrite: false, chunkSize: 4096, sleep: noSleep });
    expect(stub.fs.get("/workspace/big.bin")?.data.equals(data)).toBe(true);
    const offsets = stub.seen.filter((s) => s.method === "PUT").map((s) => new URL(s.url, "http://x").searchParams.get("offset"));
    expect(offsets).toEqual(["0", "4096", "4096", "8192"]);
    // Each failure was followed by a question about progress.
    expect(stub.seen.filter((s) => s.method === "GET" && s.url.startsWith("/api/files/uploads/"))).toHaveLength(2);
  });

  it("retries a box that is briefly down (5xx), and gives up after enough tries", async () => {
    const { stub, api, dir } = await setup();
    const { file, data } = localFile(dir, 5000);
    stub.chunkHook = (n) => (n === 0 ? 503 : undefined);
    await uploadFile({ api, file, remote: "/workspace/a.bin", overwrite: false, chunkSize: 4096, sleep: noSleep });
    expect(stub.fs.get("/workspace/a.bin")?.data.equals(data)).toBe(true);

    stub.chunkHook = () => 503;
    const slept: number[] = [];
    await expect(
      uploadFile({ api, file, remote: "/workspace/b.bin", overwrite: false, chunkSize: 4096, retries: 3, sleep: async (ms) => void slept.push(ms) }),
    ).rejects.toThrow(/503/);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("halves the chunk when something in between takes less than the API does", async () => {
    const { stub, api, dir } = await setup();
    const { file, data } = localFile(dir, 3 * 1024 * 1024);
    let first = true;
    stub.chunkHook = () => {
      if (first) {
        first = false;
        return 413;
      }
    };
    await uploadFile({ api, file, remote: "/workspace/c.bin", overwrite: false, chunkSize: 2 * 1024 * 1024, sleep: noSleep });
    expect(stub.fs.get("/workspace/c.bin")?.data.equals(data)).toBe(true);
    const lengths = stub.seen.filter((s) => s.method === "PUT").map((s) => Number(s.headers["content-length"]));
    expect(lengths[0]).toBe(2 * 1024 * 1024);
    expect(lengths.slice(1).every((n) => n <= 1024 * 1024)).toBe(true);
  });

  it("reads the offset the box asks for from its refusal", () => {
    expect(resumeOffset(new ApiError(409, "expected a chunk at offset 123", "offset:123"))).toBe(123);
    expect(resumeOffset(new ApiError(409, "exists", "exists"))).toBeNull();
    expect(resumeOffset(new ApiError(400, "x", "offset:1"))).toBeNull();
    expect(resumeOffset(new CliError("x"))).toBeNull();
  });

  it("jumps ahead when the box already has more than this run sent", async () => {
    const { stub, api, dir } = await setup();
    const { file, data } = localFile(dir, 9000);
    // Another client (an earlier run) got the first chunk there already.
    const started = await api.startUpload("/workspace/j.bin", 9000, false);
    const up = stub.uploads.get(started.uploadId)!;
    data.copy(up.data, 0, 0, 4096);
    up.received = 4096;
    const resume = new ResumeStore(tmpDir());
    const key = ResumeStore.key({ box: api.client.origin, local: path.resolve(file), remote: "/workspace/j.bin", size: 9000, mtimeMs: fs.statSync(file).mtimeMs });
    resume.set(key, started.uploadId, "/workspace/j.bin");
    await uploadFile({ api, file, remote: "/workspace/j.bin", overwrite: false, chunkSize: 4096, resume });
    expect(stub.fs.get("/workspace/j.bin")?.data.equals(data)).toBe(true);
    expect(stub.seen.filter((s) => s.method === "PUT").map((s) => new URL(s.url, "http://x").searchParams.get("offset"))).toEqual(["4096", "8192"]);
  });

  it("resumes an upload cut off in an earlier run, sending only what is missing", async () => {
    const { stub, api, dir } = await setup();
    const { file, data } = localFile(dir, 20_000);
    const resume = new ResumeStore(tmpDir());
    // The first run is interrupted after two chunks (Ctrl-C).
    const abort = new AbortController();
    stub.chunkHook = (n) => {
      if (n === 2) abort.abort();
    };
    await expect(
      uploadFile({ api, file, remote: "/workspace/r.bin", overwrite: false, chunkSize: 4096, resume, signal: abort.signal, sleep: noSleep }),
    ).rejects.toMatchObject({ exitCode: EXIT.INTERRUPTED });
    expect(stub.fs.has("/workspace/r.bin")).toBe(false);
    const takenBefore = stub.bytesTaken;
    expect(takenBefore).toBeGreaterThanOrEqual(8192);

    // The same command again picks up where the box left off.
    stub.chunkHook = null;
    let resumedAt = -1;
    await uploadFile({ api, file, remote: "/workspace/r.bin", overwrite: false, chunkSize: 4096, resume, onResume: (n) => (resumedAt = n) });
    expect(resumedAt).toBe(takenBefore);
    expect(stub.bytesTaken - takenBefore).toBe(20_000 - takenBefore);
    expect(stub.fs.get("/workspace/r.bin")?.data.equals(data)).toBe(true);
    expect(stub.seen.filter((s) => s.method === "POST" && s.url === "/api/files/uploads")).toHaveLength(1);
    // Finished: nothing left to resume.
    expect(JSON.parse(fs.readFileSync(resume.file, "utf8"))).toEqual({});
  });

  it("starts afresh when the remembered upload is gone, or was asked for differently", async () => {
    const { stub, api, dir } = await setup();
    const { file } = localFile(dir, 5000);
    const resume = new ResumeStore(tmpDir());
    const st = fs.statSync(file);
    const key = ResumeStore.key({ box: api.client.origin, local: path.resolve(file), remote: "/workspace/x.bin", size: 5000, mtimeMs: st.mtimeMs });
    resume.set(key, "0".repeat(32), "/workspace/x.bin");
    await uploadFile({ api, file, remote: "/workspace/x.bin", overwrite: false, resume });
    expect(stub.fs.get("/workspace/x.bin")?.data.length).toBe(5000);

    // An upload started without --force is not resumed by a run with it.
    put(stub, "/workspace/y.bin", "old");
    const started = await api.startUpload("/workspace/z.bin", 5000, false);
    const key2 = ResumeStore.key({ box: api.client.origin, local: path.resolve(file), remote: "/workspace/y.bin", size: 5000, mtimeMs: st.mtimeMs });
    resume.set(key2, started.uploadId, "/workspace/y.bin");
    await uploadFile({ api, file, remote: "/workspace/y.bin", overwrite: true, resume });
    expect(stub.fs.get("/workspace/y.bin")?.data.length).toBe(5000);
    expect(stub.uploads.has(started.uploadId)).toBe(false);
  });

  it("refuses to replace a file unless told to, keeping the old one in the trash when told", async () => {
    const { stub, api, dir } = await setup();
    const { file } = localFile(dir, 100);
    put(stub, "/workspace/exists.bin", "old");
    await expect(uploadFile({ api, file, remote: "/workspace/exists.bin", overwrite: false })).rejects.toMatchObject({ status: 409, code: "exists" });
    await uploadFile({ api, file, remote: "/workspace/exists.bin", overwrite: true });
    expect(stub.fs.get("/workspace/exists.bin")?.data.length).toBe(100);
    expect(stub.trashed).toContain("/workspace/exists.bin");
  });
});

describe("many requests", () => {
  it("go over kept-alive sockets without leaking listeners", async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error): void => void warnings.push(`${w.name}: ${w.message}`);
    process.on("warning", onWarning);
    try {
      const { stub, api, dir } = await setup();
      const { file, data } = localFile(dir, 300 * 1024);
      await uploadFile({ api, file, remote: "/workspace/many.bin", overwrite: false, chunkSize: 1024 });
      expect(stub.fs.get("/workspace/many.bin")?.data.equals(data)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(warnings).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe("downloads", () => {
  it("write to a temporary file and move it into place", async () => {
    const { stub, api, dir } = await setup();
    const data = randomBytes(70_000);
    put(stub, "/workspace/d.bin", data);
    const dest = path.join(dir, "d.bin");
    fs.writeFileSync(dest, "previous");
    const seen: number[] = [];
    const n = await downloadFile({ api, remote: "/workspace/d.bin", local: dest, onProgress: (x) => seen.push(x) });
    expect(n).toBe(70_000);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
    expect(seen.at(-1)).toBe(70_000);
    expect(fs.readdirSync(dir)).toEqual(["d.bin"]);
  });

  it("leave nothing behind when the box refuses", async () => {
    const { api, dir } = await setup();
    const dest = path.join(dir, "missing.bin");
    await expect(downloadFile({ api, remote: "/workspace/missing.bin", local: dest })).rejects.toMatchObject({ exitCode: EXIT.NOT_FOUND });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
