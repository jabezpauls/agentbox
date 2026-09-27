import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createClient, type FileStat, type WebDAVClient } from "webdav";
import { filesFixture, rawPath, type FilesFixture } from "./helpers/files.js";
import { parseXml } from "../src/files/dav/xml.js";
import { parseIf } from "../src/files/dav/locks.js";

let f: FilesFixture;
let base: string;
let client: WebDAVClient;

beforeAll(async () => {
  f = await filesFixture();
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(f.app.server.address() as AddressInfo).port}/api/dav`;
  client = createClient(base);
});

afterAll(async () => {
  await f.close();
});

const ws = () => f.workspace;

/** A request whose path goes out exactly as written, unnormalised. */
function rawStatus(method: string, rawPath: string): Promise<number> {
  const { port } = f.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: rawPath, headers: { depth: "0" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function dav(method: string, p: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: init.headers ?? {}, body: init.body ?? null });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("WebDAV with a real client", () => {
  it("writes, reads, lists and stats", async () => {
    await client.createDirectory("/docs");
    await client.putFileContents("/docs/hello.txt", "hello over dav");
    expect(await client.getFileContents("/docs/hello.txt", { format: "text" })).toBe("hello over dav");
    expect(fs.readFileSync(path.join(ws(), "docs", "hello.txt"), "utf8")).toBe("hello over dav");

    const listing = (await client.getDirectoryContents("/docs")) as FileStat[];
    expect(listing.map((e) => [e.basename, e.type, e.size])).toEqual([["hello.txt", "file", 14]]);
    const stat = (await client.stat("/docs/hello.txt")) as FileStat;
    expect(stat.etag).toBeTruthy();
    expect(stat.mime).toBe("text/plain");
    expect(await client.exists("/docs/missing")).toBe(false);
  });

  it("copies and moves, refusing to overwrite when told not to", async () => {
    await client.putFileContents("/a.txt", "A");
    await client.copyFile("/a.txt", "/b.txt");
    expect(fs.readFileSync(path.join(ws(), "b.txt"), "utf8")).toBe("A");
    await client.moveFile("/b.txt", "/docs/b.txt");
    expect(fs.existsSync(path.join(ws(), "b.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(ws(), "docs", "b.txt"), "utf8")).toBe("A");
    await expect(client.copyFile("/a.txt", "/docs/b.txt", { overwrite: false })).rejects.toMatchObject({ status: 412 });
    await client.copyFile("/docs", "/docs-copy");
    expect(fs.readFileSync(path.join(ws(), "docs-copy", "hello.txt"), "utf8")).toBe("hello over dav");
  });

  it("deletes into the trash, and OS litter for good", async () => {
    await client.putFileContents("/doomed.txt", "d");
    await client.putFileContents("/._doomed.txt", "apple double");
    await client.deleteFile("/doomed.txt");
    await client.deleteFile("/._doomed.txt");
    const trash = (await f.app.inject({ method: "GET", url: "/api/files/trash" })).json() as { name: string }[];
    expect(trash.map((t) => t.name)).toEqual(["doomed.txt"]);
  });

  it("locks and unlocks, and a lock keeps other writers out", async () => {
    await client.putFileContents("/locked.txt", "v1");
    const lock = await client.lock("/locked.txt", { timeout: "Second-60" });
    expect(lock.token).toMatch(/^opaquelocktoken:/);

    // Another writer without the token is refused…
    const refused = await dav("PUT", "/locked.txt", { body: "intruder" });
    expect(refused.status).toBe(423);
    expect(fs.readFileSync(path.join(ws(), "locked.txt"), "utf8")).toBe("v1");
    expect((await dav("DELETE", "/locked.txt")).status).toBe(423);
    expect((await dav("MOVE", "/locked.txt", { headers: { destination: `${base}/elsewhere.txt` } })).status).toBe(423);

    // …the holder is not.
    const ok = await dav("PUT", "/locked.txt", { body: "v2", headers: { if: `(<${lock.token}>)` } });
    expect(ok.status).toBe(204);
    expect(fs.readFileSync(path.join(ws(), "locked.txt"), "utf8")).toBe("v2");

    // The lock shows up in PROPFIND.
    const found = await dav("PROPFIND", "/locked.txt", {
      headers: { depth: "0", "content-type": "application/xml" },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><lockdiscovery/></prop></propfind>',
    });
    expect(found.status).toBe(207);
    expect(found.text).toContain(lock.token);

    await client.unlock("/locked.txt", lock.token);
    expect((await dav("PUT", "/locked.txt", { body: "v3" })).status).toBe(204);
  });
});

describe("the WebDAV protocol, as Finder and gio use it", () => {
  it("advertises class 2", async () => {
    const res = await dav("OPTIONS", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("dav")).toBe("1, 2");
    expect(res.headers.get("allow")).toContain("LOCK");
  });

  it("answers PROPFIND depth 1 with collections marked and quota on request", async () => {
    fs.mkdirSync(path.join(ws(), "pf", "sub"), { recursive: true });
    fs.writeFileSync(path.join(ws(), "pf", "f.bin"), "12345");
    const res = await dav("PROPFIND", "/pf/", {
      headers: { depth: "1" },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:quota-available-bytes/><x:nope xmlns:x="urn:x"/></D:prop></D:propfind>',
    });
    expect(res.status).toBe(207);
    const doc = parseXml(res.text);
    const responses = doc.children.filter((c) => c.local === "response");
    expect(responses.map((r) => r.children.find((c) => c.local === "href")?.text)).toEqual([
      "/api/dav/pf/",
      "/api/dav/pf/sub/",
      "/api/dav/pf/f.bin",
    ]);
    expect(res.text).toContain("<D:collection/>");
    expect(res.text).toContain("<D:getcontentlength>5</D:getcontentlength>");
    expect(res.text).toMatch(/<D:quota-available-bytes>\d+<\/D:quota-available-bytes>/);
    // An unknown property is reported missing, in its own namespace.
    expect(res.text).toContain('<x:nope xmlns:x="urn:x"/>');
    expect(res.text).toContain("HTTP/1.1 404 Not Found");
  });

  it("refuses depth infinity, a DOCTYPE, and a path that climbs out", async () => {
    expect((await dav("PROPFIND", "/", { headers: { depth: "infinity" } })).status).toBe(403);
    const xxe = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><propfind xmlns="DAV:"><allprop/></propfind>';
    expect((await dav("PROPFIND", "/", { headers: { depth: "0" }, body: xxe })).status).toBe(400);
    // Sent byte for byte: fetch would tidy `%2e%2e` into `..` and resolve it.
    for (const p of ["/..%2f..%2fetc", "/%2e%2e/", "/%2E%2e/%2e%2e/api/rpc", "/../api/rpc", "/a%2fb", "/x%00y"]) {
      expect(await rawStatus("PROPFIND", `/api/dav${p}`), p).toBe(400);
    }
  });

  it("handles names with semicolons, backslashes, newlines and stray bytes", async () => {
    fs.writeFileSync(path.join(ws(), "a;b\\c"), "semi");
    fs.writeFileSync(path.join(ws(), "new\nline"), "nl");
    fs.writeFileSync(rawPath(ws(), [0x72, 0xff]), "raw");
    const res = await dav("PROPFIND", "/", { headers: { depth: "1" } });
    expect(res.text).toContain("/api/dav/a%3Bb%5Cc");
    expect(res.text).toContain("/api/dav/new%0Aline");
    expect(res.text).toContain("/api/dav/r%FF");
    expect((await dav("GET", "/a%3Bb%5Cc")).text).toBe("semi");
    expect((await dav("GET", "/r%FF")).text).toBe("raw");
    expect((await dav("PUT", "/r%FF", { body: "raw2" })).status).toBe(204);
    expect(fs.readFileSync(rawPath(ws(), [0x72, 0xff]), "utf8")).toBe("raw2");
  });

  it("creates an empty file when locking an unmapped URL, and needs its parent", async () => {
    const res = await dav("LOCK", "/fresh.txt", {
      headers: { timeout: "Second-30" },
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>mailto:me@example.com</D:href></D:owner></D:lockinfo>',
    });
    expect(res.status).toBe(201);
    const token = /<(opaquelocktoken:[^>]+)>/.exec(res.headers.get("lock-token") ?? "")?.[1];
    expect(token).toBeTruthy();
    expect(res.text).toContain("mailto:me@example.com");
    expect(fs.readFileSync(path.join(ws(), "fresh.txt"), "utf8")).toBe("");

    // A second exclusive lock conflicts; a refresh by token does not.
    const lockinfo = '<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>';
    expect((await dav("LOCK", "/fresh.txt", { body: lockinfo })).status).toBe(423);
    expect((await dav("LOCK", "/fresh.txt", { headers: { if: `(<${token}>)`, timeout: "Second-60" } })).status).toBe(200);
    expect((await dav("UNLOCK", "/fresh.txt", { headers: { "lock-token": "<opaquelocktoken:nope>" } })).status).toBe(409);
    expect((await dav("UNLOCK", "/fresh.txt", { headers: { "lock-token": `<${token}>` } })).status).toBe(204);

    expect((await dav("LOCK", "/no/such/dir/x", { body: lockinfo })).status).toBe(409);
  });

  it("holds a depth-infinity collection lock over new members", async () => {
    fs.mkdirSync(path.join(ws(), "held"));
    const lockinfo = '<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>';
    const res = await dav("LOCK", "/held/", { body: lockinfo });
    expect(res.status).toBe(200);
    const token = /<([^>]+)>/.exec(res.headers.get("lock-token") ?? "")?.[1] as string;
    expect((await dav("PUT", "/held/new.txt", { body: "x" })).status).toBe(423);
    expect((await dav("MKCOL", "/held/dir")).status).toBe(423);
    expect((await dav("PUT", "/held/new.txt", { body: "x", headers: { if: `(<${token}>)` } })).status).toBe(201);
    // Deleting the collection drops its lock.
    expect((await dav("DELETE", "/held/", { headers: { if: `(<${token}>)` } })).status).toBe(204);
    expect((await dav("MKCOL", "/held")).status).toBe(201);
  });

  it("fails a request whose If header does not hold", async () => {
    fs.writeFileSync(path.join(ws(), "cond.txt"), "c");
    expect((await dav("PUT", "/cond.txt", { body: "x", headers: { if: "(<opaquelocktoken:unknown>)" } })).status).toBe(412);
    expect((await dav("PUT", "/cond.txt", { body: "x", headers: { if: "(Not <DAV:no-lock>)" } })).status).toBe(204);
    const etag = (await dav("HEAD", "/cond.txt")).headers.get("etag") as string;
    expect((await dav("PUT", "/cond.txt", { body: "y", headers: { if: `(["nope"])` } })).status).toBe(412);
    expect((await dav("PUT", "/cond.txt", { body: "y", headers: { if: `([${etag}])` } })).status).toBe(204);
  });

  it("saves over a file in place, keeping its mode", async () => {
    fs.writeFileSync(path.join(ws(), "exec.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(ws(), "exec.sh"), 0o755);
    expect((await dav("PUT", "/exec.sh", { body: "#!/bin/sh\necho saved\n" })).status).toBe(204);
    expect(fs.readFileSync(path.join(ws(), "exec.sh"), "utf8")).toBe("#!/bin/sh\necho saved\n");
    expect(fs.statSync(path.join(ws(), "exec.sh")).mode & 0o777).toBe(0o755);
  });

  it("follows MKCOL and PUT's rules for parents and existing names", async () => {
    expect((await dav("MKCOL", "/m")).status).toBe(201);
    expect((await dav("MKCOL", "/m")).status).toBe(405);
    expect((await dav("MKCOL", "/missing/m")).status).toBe(409);
    expect((await dav("MKCOL", "/body", { body: "<x/>" })).status).toBe(415);
    expect((await dav("PUT", "/missing/file", { body: "x" })).status).toBe(409);
    expect((await dav("PUT", "/m", { body: "x" })).status).toBe(405);
    expect((await dav("PUT", "/ranged", { body: "x", headers: { "content-range": "bytes 0-0/1" } })).status).toBe(400);
  });

  it("hard-deletes only files by exactly the litter names, never folders", async () => {
    fs.writeFileSync(path.join(ws(), "._note.txt"), "apple double");
    fs.mkdirSync(path.join(ws(), "._folder"));
    fs.mkdirSync(path.join(ws(), ".DS_Store"));
    fs.writeFileSync(path.join(ws(), "not.DS_Store"), "user file");
    for (const p of ["/._note.txt", "/._folder/", "/.DS_Store/", "/not.DS_Store"]) {
      expect((await dav("DELETE", p)).status, p).toBe(204);
    }
    const trashed = ((await f.app.inject({ method: "GET", url: "/api/files/trash" })).json() as { name: string }[]).map((t) => t.name);
    expect(trashed).toEqual(expect.arrayContaining(["._folder", ".DS_Store", "not.DS_Store"]));
    expect(trashed).not.toContain("._note.txt");
  });

  it("does not let a destination header leave the tree", async () => {
    fs.writeFileSync(path.join(ws(), "src.txt"), "s");
    expect((await dav("COPY", "/src.txt", { headers: { destination: "http://elsewhere/etc/x" } })).status).toBe(502);
    // Another host, even with a DAV path, is another server.
    expect((await dav("COPY", "/src.txt", { headers: { destination: "http://elsewhere.example/api/dav/x.txt" } })).status).toBe(502);
    // This host, spelled absolute or as a path, is fine.
    expect((await dav("COPY", "/src.txt", { headers: { destination: `${base}/abs-copy.txt` } })).status).toBe(201);
    expect((await dav("COPY", "/src.txt", { headers: { destination: "/api/dav/path-copy.txt" } })).status).toBe(201);
    expect((await dav("COPY", "/src.txt", { headers: { destination: `${base}/..%2f..%2fx` } })).status).toBe(400);
    expect((await dav("COPY", "/src.txt", { headers: { destination: `${base}/src.txt` } })).status).toBe(403);
    expect((await dav("COPY", "/src.txt")).status).toBe(400);
  });

  it("does not show or serve links that lead out, and sandboxes what it serves", async () => {
    fs.writeFileSync(path.join(f.base, "secret.txt"), "secret");
    fs.symlinkSync(path.join(f.base, "secret.txt"), path.join(ws(), "leak"));
    fs.mkdirSync(path.join(ws(), "linked-target"));
    fs.symlinkSync("linked-target", path.join(ws(), "linked"));
    const res = await dav("PROPFIND", "/", { headers: { depth: "1" } });
    expect(res.text).not.toContain("/api/dav/leak");
    expect(res.text).toContain("/api/dav/linked/");
    expect((await dav("GET", "/leak")).status).toBe(403);

    fs.writeFileSync(path.join(ws(), "page.html"), "<script>alert(1)</script>");
    fs.writeFileSync(path.join(ws(), "code.js"), "alert(1)");
    for (const dest of ["script", "worker", "style"]) {
      expect((await dav("GET", "/code.js", { headers: { "sec-fetch-dest": dest } })).status, dest).toBe(403);
    }
    const page = await dav("GET", "/page.html");
    expect(page.headers.get("content-security-policy")).toBe("sandbox");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("applies Windows' timestamps and refuses dead properties, all or nothing", async () => {
    fs.writeFileSync(path.join(ws(), "props.txt"), "p");
    const when = "Wed, 01 Jan 2020 00:00:00 GMT";
    const ok = await dav("PROPPATCH", "/props.txt", {
      body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32LastModifiedTime>${when}</Z:Win32LastModifiedTime><Z:Win32FileAttributes>00000020</Z:Win32FileAttributes></D:prop></D:set></D:propertyupdate>`,
    });
    expect(ok.status).toBe(207);
    expect(ok.text).toContain("HTTP/1.1 200 OK");
    expect(fs.statSync(path.join(ws(), "props.txt")).mtime.toUTCString()).toBe(when);

    const mixed = await dav("PROPPATCH", "/props.txt", {
      body: `<?xml version="1.0"?><propertyupdate xmlns="DAV:"><set><prop><getlastmodified>Thu, 02 Jan 2020 00:00:00 GMT</getlastmodified><author xmlns="urn:x">me</author></prop></set></propertyupdate>`,
    });
    expect(mixed.text).toContain("HTTP/1.1 403 Forbidden");
    expect(mixed.text).toContain("HTTP/1.1 424 Failed Dependency");
    expect(fs.statSync(path.join(ws(), "props.txt")).mtime.toUTCString()).toBe(when);
  });
});

describe("what a mounted folder does not show", () => {
  it("hides the trash and upload scratch space at the root", async () => {
    await client.putFileContents("/to-trash.txt", "t");
    await client.deleteFile("/to-trash.txt");
    expect(fs.existsSync(path.join(ws(), ".agentbox", "trash"))).toBe(true);
    // Raw, because an earlier test left a name that is not UTF-8 at the root,
    // which this client library cannot decode.
    const listing = await dav("PROPFIND", "/", { headers: { depth: "1" } });
    expect(listing.text).toContain("/api/dav/docs/");
    expect(listing.text).not.toContain(".agentbox");
    expect((await dav("PROPFIND", "/.agentbox/", { headers: { depth: "0" } })).status).toBe(404);
    expect((await dav("DELETE", "/.agentbox/")).status).toBe(404);
  });

  it("refuses a prefix bound to the empty namespace", async () => {
    const body = '<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:bad=""><allprop/></propfind>';
    expect((await dav("PROPFIND", "/", { headers: { depth: "0" }, body })).status).toBe(400);
  });
});

describe("symlink loops", () => {
  const hrefs = (text: string) => [...text.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);

  it("does not present a link back up the tree as a folder, or serve paths through it", async () => {
    fs.mkdirSync(path.join(ws(), "loop", "proj"), { recursive: true });
    fs.writeFileSync(path.join(ws(), "loop", "proj", "f.txt"), "x");
    fs.symlinkSync("..", path.join(ws(), "loop", "proj", "up"));
    fs.symlinkSync(".", path.join(ws(), "loop", "proj", "self"));
    fs.mkdirSync(path.join(ws(), "loop", "proj", "sub"));
    fs.symlinkSync("sub", path.join(ws(), "loop", "proj", "sideways"));

    const listing = await dav("PROPFIND", "/loop/proj/", { headers: { depth: "1" } });
    expect(listing.status).toBe(207);
    expect(hrefs(listing.text).sort()).toEqual(
      ["/api/dav/loop/proj/", "/api/dav/loop/proj/f.txt", "/api/dav/loop/proj/sideways/", "/api/dav/loop/proj/sub/"].sort(),
    );

    // The reviewer's walk down the loop names nothing.
    for (const p of ["/loop/proj/up/", "/loop/proj/up/proj/up/proj/", "/loop/proj/self/", "/loop/proj/self/f.txt"]) {
      expect((await dav("PROPFIND", p, { headers: { depth: "1" } })).status, p).toBe(404);
      expect((await dav("GET", p)).status, p).toBe(404);
    }
    // A link that is not a loop still works.
    expect((await dav("PROPFIND", "/loop/proj/sideways/", { headers: { depth: "0" } })).status).toBe(207);
  });

  it("hides two folders that link to each other after the first step", async () => {
    fs.mkdirSync(path.join(ws(), "pair", "a"), { recursive: true });
    fs.mkdirSync(path.join(ws(), "pair", "b"));
    fs.symlinkSync("../b", path.join(ws(), "pair", "a", "to-b"));
    fs.symlinkSync("../a", path.join(ws(), "pair", "b", "to-a"));
    const inB = await dav("PROPFIND", "/pair/a/to-b/", { headers: { depth: "1" } });
    expect(inB.status).toBe(207);
    // From a into b, the link back to a is where we came from.
    expect(hrefs(inB.text)).toEqual(["/api/dav/pair/a/to-b/"]);
    expect((await dav("PROPFIND", "/pair/a/to-b/to-a/", { headers: { depth: "0" } })).status).toBe(404);
  });
});

describe("If header parsing", () => {
  it("reads tagged and untagged lists, Not, and entity tags", () => {
    expect(parseIf('(<urn:a> ["etag"]) (Not <DAV:no-lock>)')).toEqual([
      { resource: null, conditions: [{ not: false, kind: "token", value: "urn:a" }, { not: false, kind: "etag", value: '"etag"' }] },
      { resource: null, conditions: [{ not: true, kind: "token", value: "DAV:no-lock" }] },
    ]);
    expect(parseIf("<http://h/api/dav/x> (<t>)")?.[0]?.resource).toBe("http://h/api/dav/x");
    expect(parseIf("garbage")).toBeNull();
    expect(parseIf("()")).toBeNull();
  });
});
