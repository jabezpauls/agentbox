import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  BadPath,
  canonicalPath,
  DavFront,
  isLocalHost,
  rewriteXmlHrefs,
  toLocalHref,
  toRemoteDestination,
  toRemoteIf,
  toRemotePath,
  type DavMap,
} from "../src/dav.js";
import { BoxClient } from "../src/http.js";
import { TOKEN, stubServer, type Stub } from "./helpers.js";

const SECRET = "s3cr3t-Path_Secret0";
const PORT = 41234;
const M: DavMap = {
  localPrefix: `/${SECRET}`,
  localOrigin: `http://127.0.0.1:${PORT}`,
  remoteOrigin: "https://box.example",
  remotePrefix: "/api/dav",
};

describe("request paths", () => {
  it("map under the secret to the box's /api/dav", () => {
    expect(toRemotePath(`/${SECRET}`, M)).toBe("/api/dav");
    expect(toRemotePath(`/${SECRET}/`, M)).toBe("/api/dav/");
    expect(toRemotePath(`/${SECRET}/proj/a%20b.txt`, M)).toBe("/api/dav/proj/a%20b.txt");
    expect(toRemotePath(`/${SECRET}/dir/?x=1`, M)).toBe("/api/dav/dir/?x=1");
  });

  it("answer nothing outside the secret", () => {
    for (const p of ["/", "/api/dav/", `/${SECRET}x/`, `/${SECRET.slice(0, -1)}/`, "/other"]) expect(toRemotePath(p, M), p).toBeNull();
  });

  it("are respelled the one way the gate accepts, and dot segments refused", () => {
    expect(canonicalPath("/a//b%2Ec/")).toBe("/a/b.c/");
    expect(canonicalPath("/semi;colon")).toBe("/semi%3Bcolon");
    expect(canonicalPath("/caf%c3%a9")).toBe("/caf%C3%A9");
    expect(canonicalPath("/café")).toBe("/caf%C3%A9");
    expect(canonicalPath("/100%")).toBe("/100%25");
    for (const bad of ["/..", "/a/%2e%2e/b", "/a/%2E", "/a%2Fb", "/a%5cb", "/a%00b"]) expect(() => canonicalPath(bad), bad).toThrow(BadPath);
  });
});

describe("the Destination and If headers", () => {
  it("move to the box's own origin and prefix", () => {
    expect(toRemoteDestination(`http://127.0.0.1:${PORT}/${SECRET}/a/b.txt`, M, PORT)).toBe("https://box.example/api/dav/a/b.txt");
    expect(toRemoteDestination(`http://localhost:${PORT}/${SECRET}/x`, M, PORT)).toBe("https://box.example/api/dav/x");
    expect(toRemoteDestination(`/${SECRET}/rel%20ative`, M, PORT)).toBe("https://box.example/api/dav/rel%20ative");
  });

  it("are not moved when they name somewhere else", () => {
    for (const d of [
      `http://127.0.0.1:${PORT + 1}/${SECRET}/x`,
      `http://evil.example/${SECRET}/x`,
      `http://127.0.0.1:${PORT}/other/x`,
      `http://127.0.0.1:${PORT}/${SECRET}/../../etc`,
      `https://127.0.0.1:${PORT}/${SECRET}/x`,
      "::not a url",
    ]) {
      expect(toRemoteDestination(d, M, PORT), d).toBeNull();
    }
  });

  it("If: resource tags move, lock tokens stay", () => {
    const value = `<http://127.0.0.1:${PORT}/${SECRET}/a.txt> (<opaquelocktoken:abc-123>) </${SECRET}/b> (<urn:uuid:1> ["etag"])`;
    expect(toRemoteIf(value, M, PORT)).toBe("<https://box.example/api/dav/a.txt> (<opaquelocktoken:abc-123>) <https://box.example/api/dav/b> (<urn:uuid:1> [\"etag\"])");
  });

  it("knows only loopback hosts as its own", () => {
    expect(isLocalHost(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isLocalHost(`localhost:${PORT}`, PORT)).toBe(true);
    expect(isLocalHost(`[::1]:${PORT}`, PORT)).toBe(true);
    for (const h of [`evil.example:${PORT}`, "127.0.0.1", `127.0.0.1:${PORT + 1}`, undefined]) expect(isLocalHost(h, PORT), String(h)).toBe(false);
  });
});

describe("hrefs in responses", () => {
  it("move back under the secret, path or absolute", () => {
    expect(toLocalHref("/api/dav/a%20b/", M)).toBe(`/${SECRET}/a%20b/`);
    expect(toLocalHref("/api/dav", M)).toBe(`/${SECRET}`);
    expect(toLocalHref("https://box.example/api/dav/x", M)).toBe(`http://127.0.0.1:${PORT}/${SECRET}/x`);
    for (const other of ["https://elsewhere.example/api/dav/x", "/api/davx", "/other", "mailto:x@y"]) expect(toLocalHref(other, M), other).toBe(other);
  });

  it("are rewritten wherever the DAV namespace's prefix puts them", () => {
    const xml =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
      "<D:response><D:href>/api/dav/</D:href></D:response>" +
      "<D:response><D:href>/api/dav/a&amp;b.txt</D:href><D:propstat><D:prop><D:lockdiscovery><D:activelock>" +
      "<D:lockroot><D:href>/api/dav/a&amp;b.txt</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop></D:propstat></D:response>" +
      '<response xmlns="DAV:"><href>https://box.example/api/dav/c</href></response>' +
      "<D:response><d:href >/api/dav/lower</d:href ></D:response>" +
      "</D:multistatus>";
    const out = rewriteXmlHrefs(xml, M);
    expect(out).not.toContain("/api/dav");
    expect(out).toContain(`<D:href>/${SECRET}/</D:href>`);
    expect(out.match(new RegExp(`<D:href>/${SECRET}/a&amp;b.txt</D:href>`, "g"))).toHaveLength(2);
    expect(out).toContain(`<href>http://127.0.0.1:${PORT}/${SECRET}/c</href>`);
    expect(out).toContain(`<d:href >/${SECRET}/lower</d:href >`);
  });
});

/** Talk to the front as a WebDAV client would. */
function send(
  url: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
  rawPath?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: rawPath ?? `${u.pathname}${u.search}`, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the local WebDAV front", () => {
  let box: Stub | null = null;
  let front: DavFront | null = null;
  afterEach(async () => {
    await front?.close();
    await box?.close();
    front = null;
    box = null;
  });

  async function start(): Promise<{ url: string; box: Stub }> {
    box = await stubServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "PROPFIND") {
        const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${url}</D:href></D:response><D:response><D:href>/api/dav/f.xml</D:href></D:response></D:multistatus>`;
        res.writeHead(207, { "content-type": "application/xml; charset=utf-8", "content-length": String(Buffer.byteLength(xml)) });
        return void res.end(xml);
      }
      if (req.method === "GET" && url === "/api/dav/f.xml") {
        // A file's own content, which happens to look like a multistatus.
        res.writeHead(200, { "content-type": "application/xml" });
        return void res.end("<D:href>/api/dav/keep-me</D:href>");
      }
      if (req.method === "MKCOL") {
        res.writeHead(201, { location: `${url}`, "set-cookie": "a=b", "www-authenticate": "Basic" });
        return void res.end();
      }
      res.writeHead(204);
      res.end();
    });
    front = new DavFront(new BoxClient(box.url, TOKEN), { secret: SECRET });
    const url = await front.start();
    return { url, box };
  }

  it("serves under the secret on loopback, carrying the token and nothing of the client's", async () => {
    const { url, box: b } = await start();
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${SECRET}/$`));
    const res = await send(`${url}proj/`, "PROPFIND", { depth: "1", authorization: "Basic dXNlcjpwdw==", cookie: "session=1", origin: "http://evil.example" }, "<propfind/>");
    expect(res.status).toBe(207);
    const seen = b.seen[0]!;
    expect(seen.url).toBe("/api/dav/proj/");
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.origin).toBeUndefined();
    expect(seen.headers.host).toBe(new URL(b.url).host);
    expect(seen.headers["accept-encoding"]).toBe("identity");
    expect(seen.body.toString()).toBe("<propfind/>");
    expect(res.body).toContain(`<D:href>/${SECRET}/proj/</D:href>`);
    expect(res.body).toContain(`<D:href>/${SECRET}/f.xml</D:href>`);
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(res.body)));
  });

  it("never edits a file's own content", async () => {
    const { url } = await start();
    const res = await send(`${url}f.xml`, "GET");
    expect(res.body).toBe("<D:href>/api/dav/keep-me</D:href>");
  });

  it("moves Destination to the box, and refuses one elsewhere itself", async () => {
    const { url, box: b } = await start();
    const port = new URL(url).port;
    const ok = await send(`${url}a.txt`, "MOVE", { destination: `http://127.0.0.1:${port}/${SECRET}/b.txt`, overwrite: "F" });
    expect(ok.status).toBe(204);
    expect(b.seen[0]?.headers.destination).toBe(`${b.url}/api/dav/b.txt`);
    expect(b.seen[0]?.headers.overwrite).toBe("F");
    const away = await send(`${url}a.txt`, "COPY", { destination: "http://other.example/x" });
    expect(away.status).toBe(502);
    expect(b.seen).toHaveLength(1);
  });

  it("rewrites Location, and drops the box's cookies and auth challenges", async () => {
    const { url } = await start();
    const res = await send(`${url}newdir/`, "MKCOL");
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/${SECRET}/newdir/`);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("answers a wrong secret, a foreign Host or a bad path itself", async () => {
    const { url, box: b } = await start();
    const u = new URL(url);
    expect((await send(`http://127.0.0.1:${u.port}/not-the-secret/`, "PROPFIND")).status).toBe(404);
    expect((await send(`http://127.0.0.1:${u.port}/`, "GET")).status).toBe(404);
    expect((await send(url, "PROPFIND", { host: `rebind.example:${u.port}` })).status).toBe(403);
    expect((await send(url, "GET", {}, undefined, `/${SECRET}/a/%2e%2e/b`)).status).toBe(400);
    expect((await send(url, "GET", {}, undefined, `/${SECRET}/a%2fb`)).status).toBe(400);
    expect(b.seen).toHaveLength(0);
  });

  it("says 502 when the box cannot be reached", async () => {
    const { url, box: b } = await start();
    await b.close();
    box = null;
    expect((await send(`${url}x`, "GET")).status).toBe(502);
  });
});
