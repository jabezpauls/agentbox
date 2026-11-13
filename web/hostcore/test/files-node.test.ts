import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesService } from "../src/files/service.js";
import { serveFiles } from "../src/files/http.js";
import { tmpBase } from "./helpers/tmp.js";

// What a machine's node needs beyond the box: its state kept on another
// volume than the folders it serves (a Windows node's folder is on C:, a
// served folder may be on D:), and paths spelled another way in the API.

const shm = "/dev/shm";
const devOf = (p: string): number | null => {
  try {
    return fs.statSync(p).dev;
  } catch {
    return null;
  }
};
const crossVolume = devOf(shm) !== null && devOf(shm) !== devOf(tmpBase());

describe.runIf(crossVolume)("state on another volume than the root", () => {
  let base: string;
  let state: string;
  let svc: FilesService;
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(tmpBase(), "wb-xvol-"));
    state = fs.mkdtempSync(path.join(shm, "wb-xvol-state-"));
    svc = new FilesService({ roots: [{ id: "r1", path: base, mode: "write", stateDir: state }] });
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  it("writes over a file, uploads, and restores from the trash", async () => {
    const file = path.join(base, "a.txt");
    await svc.ops.write({ path: file, content: "one" });
    await svc.ops.write({ path: file, content: "two", overwrite: true });
    expect(fs.readFileSync(file, "utf8")).toBe("two");

    const up = await svc.uploads.start({ path: path.join(base, "up.bin"), size: 5 });
    await svc.uploads.put(up.id, "0", Readable.from([Buffer.from("hello")]), 5);
    await svc.uploads.finish(up.id);
    expect(fs.readFileSync(path.join(base, "up.bin"), "utf8")).toBe("hello");

    await svc.ops.copy({ from: file, to: path.join(base, "b.txt") });
    expect(fs.readFileSync(path.join(base, "b.txt"), "utf8")).toBe("two");

    fs.mkdirSync(path.join(base, "dir"));
    fs.writeFileSync(path.join(base, "dir", "x"), "x");
    const t = await svc.trash.trash([path.join(base, "dir")]);
    expect(fs.existsSync(path.join(base, "dir"))).toBe(false);
    await svc.trash.restore(t.trashed[0]!.id, undefined);
    expect(fs.readFileSync(path.join(base, "dir", "x"), "utf8")).toBe("x");
    // No scratch file left behind in the owner's folder.
    expect(fs.readdirSync(base).filter((n) => n.startsWith(".")).sort()).toEqual([]);
  });
});

describe("paths spelled another way in the API", () => {
  let base: string;
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(tmpBase(), "wb-apipaths-"));
    fs.mkdirSync(path.join(base, "root"));
    fs.writeFileSync(path.join(base, "root", "f.txt"), "f");
    const real = path.join(base, "root");
    // A stand-in for Windows' `/C:/…`: `/@/…` in the API is the root on disk.
    const svc = new FilesService({
      roots: [{ id: "r1", path: real, mode: "write", stateDir: path.join(base, "state") }],
      apiPaths: {
        toHost: (p) => (p === "/@" ? real : p.startsWith("/@/") ? path.join(real, p.slice(3)) : p),
        toApi: (p) => (p === real ? "/@" : p.startsWith(real + "/") ? `/@/${p.slice(real.length + 1)}` : p),
      },
    });
    server = http.createServer((req, res) => void serveFiles(svc, req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${url}${p}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  it("maps what a request names and what an answer reports", async () => {
    const list = await call("GET", `/api/files/list?path=${encodeURIComponent("/@")}`);
    expect(list.status).toBe(200);
    expect(list.json.path).toBe("/@");
    expect((list.json.entries as Array<{ path: string }>).map((e) => e.path)).toEqual(["/@/f.txt"]);
    const moved = await call("POST", "/api/files/move", { from: "/@/f.txt", to: "/@/g.txt" });
    expect(moved.json.path).toBe("/@/g.txt");
    const w = await call("POST", "/api/files/write", { path: "/@/h.txt", content: "/@/not-a-path" });
    expect(w.json.path).toBe("/@/h.txt");
    expect(fs.readFileSync(path.join(base, "root", "h.txt"), "utf8")).toBe("/@/not-a-path");
    const t = await call("POST", "/api/files/trash", { paths: ["/@/h.txt", "/@/gone.txt"] });
    expect(t.json).toMatchObject({ trashed: [{ originalPath: "/@/h.txt" }], missing: ["/@/gone.txt"] });
    const up = await call("POST", "/api/files/uploads", { path: "/@/u.txt", size: 1 });
    expect(up.json.path).toBe("/@/u.txt");
  });
});
