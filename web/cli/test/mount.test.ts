import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import { driveFromNetUse, findOnPath, gvfsMountName, mountPlan } from "../src/mount.js";
import { capture, json, runCli, signedIn, stubServer, tmpDir, type Stub } from "./helpers.js";

const base = { url: "http://127.0.0.1:4100/SECRET/", boxName: "work", home: "/Users/me" };

describe("mount plans", () => {
  it("macOS: mount_webdav at the folder (default ~/agentbox/<box>), umount after", () => {
    const plan = mountPlan({ ...base, platform: "darwin", dir: null, env: {} });
    expect(plan.helper).toBe("mount_webdav");
    expect(plan.mount).toEqual({ command: "mount_webdav", args: ["-S", "-v", "work", base.url, "/Users/me/agentbox/work"] });
    expect(plan.unmount).toEqual({ command: "umount", args: ["/Users/me/agentbox/work"] });
    expect(plan.mountpoint).toBe("/Users/me/agentbox/work");
  });

  it("Linux: gio mount of dav://, gvfs's own folder, and a link where asked", () => {
    const plan = mountPlan({ ...base, platform: "linux", dir: "/home/me/box", env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
    expect(plan.mount).toEqual({ command: "gio", args: ["mount", "dav://127.0.0.1:4100/SECRET/"] });
    expect(plan.unmount).toEqual({ command: "gio", args: ["mount", "-u", "dav://127.0.0.1:4100/SECRET/"] });
    expect(plan.gvfsRoot).toBe("/run/user/1000/gvfs");
    expect(plan.where).toBeNull();
    expect(plan.link).toBe("/home/me/box");
    expect(plan.install).toMatch(/gvfs-backends/);
  });

  it("finds the mount's folder among gvfs's, whatever parameters the release adds", () => {
    const names = [
      "sftp:host=example.com",
      "dav:host=127.0.0.1,port=4101,ssl=false,prefix=%2FSECRET",
      "dav:host=127.0.0.1,port=4100,ssl=false,prefix=%2FOTHER",
      // As Debian 12's gvfs names it.
      "dav:host=127.0.0.1,port=4100,ssl=false,prefix=%2FSECRET",
    ];
    expect(gvfsMountName(names, 4100, "SECRET")).toBe("dav:host=127.0.0.1,port=4100,ssl=false,prefix=%2FSECRET");
    expect(gvfsMountName(["dav:host=127.0.0.1,port=4100,prefix=%2FSECRET"], 4100, "SECRET")).toBe("dav:host=127.0.0.1,port=4100,prefix=%2FSECRET");
    expect(gvfsMountName(names, 4102, "SECRET")).toBeNull();
  });

  it("Windows: net use to a drive letter, or the next free one", () => {
    const any = mountPlan({ ...base, platform: "win32", dir: null, env: {} });
    expect(any.mount).toEqual({ command: "net", args: ["use", "*", base.url, "/persistent:no"] });
    expect(any.unmount).toBeNull();
    const z = mountPlan({ ...base, platform: "win32", dir: "z:", env: {} });
    expect(z.unmount).toEqual({ command: "net", args: ["use", "z:", "/delete", "/y"] });
    expect(() => mountPlan({ ...base, platform: "win32", dir: "C:\\stuff", env: {} })).toThrow(/drive letter/);
    expect(driveFromNetUse("Drive Z: is now connected to http://127.0.0.1:4100/SECRET/.\r\n")).toBe("Z:");
  });

  it("finds helpers on PATH, and only executable files", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "gio"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "notexec"), "", { mode: 0o644 });
    expect(findOnPath("gio", { PATH: `/nonexistent:${dir}` }, "linux")).toBe(path.join(dir, "gio"));
    if (process.platform !== "win32") expect(findOnPath("notexec", { PATH: dir }, "linux")).toBeNull();
    expect(findOnPath("nothing-called-this", { PATH: dir }, "linux")).toBeNull();
  });
});

describe("the mount command", () => {
  let box: Stub | null = null;
  afterEach(async () => {
    await box?.close();
    box = null;
  });

  async function davBox(status = 207): Promise<string> {
    box = await stubServer((req, res) => {
      if (req.method === "PROPFIND") {
        res.writeHead(status, { "content-type": "application/xml" });
        return void res.end("<D:multistatus xmlns:D='DAV:'/>");
      }
      json(res, 404, {});
    });
    return signedIn(box.url);
  }

  it("says plainly when the OS helper is missing, and how to do without", async () => {
    const cfg = await davBox();
    const r = await runCli(["mount"], { configDir: cfg, env: { PATH: tmpDir() }, platform: "linux" });
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.stderr).toMatch(/gio was not found/);
    expect(r.stderr).toMatch(/--no-mount/);
  });

  it("says when the box has no WebDAV", async () => {
    const cfg = await davBox(404);
    const r = await runCli(["mount", "--no-mount"], { configDir: cfg });
    expect(r.code).toBe(EXIT.NOT_FOUND);
    expect(r.stderr).toMatch(/does not serve WebDAV/);
  });

  it("serves until stopped with --no-mount, printing the URL", async () => {
    const cfg = await davBox();
    const stdout = capture();
    const ctrlC = new AbortController();
    const running = runCli(["mount", "--no-mount", "--json"], { configDir: cfg, stdout, signal: ctrlC.signal });
    const deadline = Date.now() + 5000;
    while (!stdout.text() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const { url } = JSON.parse(stdout.text()) as { url: string };
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/);
    const res = await fetch(url, { method: "PROPFIND", headers: { depth: "0" } });
    expect(res.status).toBe(207);
    ctrlC.abort();
    expect((await running).code).toBe(0);
    // Stopped: nothing listens there any more.
    await expect(fetch(url, { method: "PROPFIND" })).rejects.toThrow();
  });
});
