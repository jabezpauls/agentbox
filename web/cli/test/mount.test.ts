import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import { driveFromNetUse, findOnPath, gvfsMountName, mountPlan, mountWebdavCredentials, runStep } from "../src/mount.js";
import { capture, json, runCli, signedIn, stubServer, tmpDir, type Stub } from "./helpers.js";

const creds = { user: "agentbox", password: "pw-Secret_123" };
const base = { url: "http://127.0.0.1:4100/SECRET/", boxName: "work", home: "/Users/me", credentials: creds };
const posix = process.platform !== "win32";

describe("mount plans", () => {
  it("macOS: mount_webdav at the folder (default ~/agentbox/<box>), the credentials on fd 3, umount after", () => {
    const plan = mountPlan({ ...base, platform: "darwin", dir: null, env: {} });
    expect(plan.helper).toBe("mount_webdav");
    expect(plan.mount.args).toEqual(["-S", "-a", "3", "-v", "work", base.url, "/Users/me/agentbox/work"]);
    expect(plan.mount.args.join(" ")).not.toContain(creds.password);
    expect(plan.mount.fd3).toEqual(mountWebdavCredentials(creds));
    expect(plan.unmount).toEqual({ command: "umount", args: ["/Users/me/agentbox/work"] });
    expect(plan.mountpoint).toBe("/Users/me/agentbox/work");
  });

  it("writes mount_webdav's credential record as webdavfs reads it", () => {
    const b = mountWebdavCredentials({ user: "ab", password: "xyz" });
    // user, password, proxy user, proxy password, certificates: 32-bit big-endian length + bytes each.
    expect(b.toString("hex")).toBe(["00000002", "6162", "00000003", "78797a", "00000000", "00000000", "00000000"].join(""));
  });

  it("Linux: gio mount of dav://, the credentials on its standard input, gvfs's own folder, a link where asked", () => {
    const plan = mountPlan({ ...base, platform: "linux", dir: "/home/me/box", env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
    expect(plan.mount).toEqual({ command: "gio", args: ["mount", "dav://127.0.0.1:4100/SECRET/"], input: `agentbox\n${creds.password}\n` });
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
      // As Debian 12's gvfs names it once credentials were given.
      "dav:host=127.0.0.1,port=4100,ssl=false,user=agentbox,prefix=%2FSECRET",
    ];
    expect(gvfsMountName(names, 4100, "SECRET")).toBe("dav:host=127.0.0.1,port=4100,ssl=false,user=agentbox,prefix=%2FSECRET");
    expect(gvfsMountName(["dav:host=127.0.0.1,port=4100,prefix=%2FSECRET"], 4100, "SECRET")).toBe("dav:host=127.0.0.1,port=4100,prefix=%2FSECRET");
    expect(gvfsMountName(names, 4102, "SECRET")).toBeNull();
  });

  it("Windows: net use to a drive letter, or the next free one, with no credentials (WebClient sends none over http)", () => {
    const any = mountPlan({ ...base, credentials: null, platform: "win32", dir: null, env: {} });
    expect(any.mount).toEqual({ command: "net", args: ["use", "*", base.url, "/persistent:no"] });
    expect(any.unmount).toBeNull();
    const z = mountPlan({ ...base, credentials: null, platform: "win32", dir: "z:", env: {} });
    expect(z.unmount).toEqual({ command: "net", args: ["use", "z:", "/delete", "/y"] });
    expect(() => mountPlan({ ...base, platform: "win32", dir: "C:\\stuff", env: {} })).toThrow(/drive letter/);
    expect(driveFromNetUse("Drive Z: is now connected to http://127.0.0.1:4100/SECRET/.\r\n")).toBe("Z:");
  });

  it("finds helpers on PATH, and only executable files; Windows names with or without their extension", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "gio"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "notexec"), "", { mode: 0o644 });
    fs.writeFileSync(path.join(dir, "code.cmd"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "notepad.exe"), "", { mode: 0o755 });
    expect(findOnPath("gio", { PATH: `/nonexistent:${dir}` }, "linux")).toBe(path.join(dir, "gio"));
    if (posix) expect(findOnPath("notexec", { PATH: dir }, "linux")).toBeNull();
    expect(findOnPath("nothing-called-this", { PATH: dir }, "linux")).toBeNull();
    expect(findOnPath("code", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")?.toLowerCase()).toBe(path.join(dir, "code.cmd").toLowerCase());
    expect(findOnPath("notepad.exe", { PATH: dir }, "win32")).toBe(path.join(dir, "notepad.exe"));
  });

  it.runIf(posix)("passes the helper its standard input and fd 3, and leaves no file with the credentials behind", async () => {
    const dir = tmpDir();
    const out = path.join(dir, "seen");
    const helper = path.join(dir, "helper.sh");
    fs.writeFileSync(helper, `#!/bin/sh\nread -r a; read -r b; printf '%s|%s|' "$a" "$b" > '${out}'; od -An -tx1 <&3 | tr -d ' \\n' >> '${out}'; echo "argv: $*"\n`, { mode: 0o755 });
    const r = await runStep({ command: helper, args: ["x"], input: "agentbox\npw\n", fd3: Buffer.from("hi") });
    expect(r).toEqual({ code: 0, output: "argv: x" });
    expect(fs.readFileSync(out, "utf8")).toBe("agentbox|pw|6869");
    expect(fs.readdirSync(path.dirname(fs.mkdtempSync(path.join(dir, "probe-")))).filter((n) => n.startsWith("agentbox-mount-"))).toEqual([]);
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

  async function until(what: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!what() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
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

  it("serves until stopped with --no-mount, printing the URL and the credentials it asks for", async () => {
    const cfg = await davBox();
    const stdout = capture();
    const ctrlC = new AbortController();
    const running = runCli(["mount", "--no-mount", "--json"], { configDir: cfg, stdout, signal: ctrlC.signal });
    await until(() => stdout.text() !== "");
    const { url, user, password } = JSON.parse(stdout.text()) as { url: string; user: string; password: string };
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/);
    expect(user).toBe("agentbox");
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await fetch(url, { method: "PROPFIND", headers: { depth: "0" } })).status).toBe(401);
    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    expect((await fetch(url, { method: "PROPFIND", headers: { depth: "0", authorization } })).status).toBe(207);
    ctrlC.abort();
    expect((await running).code).toBe(0);
    // Stopped: nothing listens there any more.
    await expect(fetch(url, { method: "PROPFIND" })).rejects.toThrow();
  });

  it.runIf(posix)("mounts with gio, the password on its standard input and never in its arguments, and links where asked", async () => {
    const cfg = await davBox();
    const bin = tmpDir();
    const runtime = tmpDir();
    const log = path.join(bin, "log");
    // A stand-in gio: records what it was given, and makes (or removes) the
    // folder gvfs would show the mount as.
    fs.writeFileSync(
      path.join(bin, "gio"),
      [
        "#!/bin/sh",
        `echo "argv: $*" >> '${log}'`,
        'if [ "$2" = "-u" ]; then rm -rf "$XDG_RUNTIME_DIR"/gvfs/dav:*; exit 0; fi',
        `read -r user; read -r pass; echo "stdin: $user $pass" >> '${log}'`,
        'hp=${2#dav://}; hostport=${hp%%/*}; rest=${hp#*/}; secret=${rest%/}',
        'mkdir -p "$XDG_RUNTIME_DIR/gvfs/dav:host=127.0.0.1,port=${hostport#*:},ssl=false,user=$user,prefix=%2F$secret"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const home = tmpDir();
    fs.chmodSync(home, 0o700);
    const link = path.join(home, "box");
    const stdout = capture();
    const ctrlC = new AbortController();
    const running = runCli(["mount", link, "--json"], {
      configDir: cfg,
      stdout,
      signal: ctrlC.signal,
      platform: "linux",
      env: { PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: runtime },
    });
    await until(() => stdout.text() !== "");
    const shown = JSON.parse(stdout.text()) as { url: string; mountedAt: string };
    expect(shown.mountedAt).toBe(link);
    expect(fs.readlinkSync(link)).toMatch(/gvfs\/dav:host=127\.0\.0\.1,port=\d+,ssl=false,user=agentbox,prefix=%2F[A-Za-z0-9_-]{22}$/);
    const seen = fs.readFileSync(log, "utf8");
    const password = /^stdin: agentbox (\S+)$/m.exec(seen)?.[1];
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(seen.split("\n").filter((l) => l.startsWith("argv:")).join("\n")).not.toContain(password as string);
    ctrlC.abort();
    expect((await running).code).toBe(0);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toMatch(/argv: mount -u dav:/);
  });

  it.runIf(posix)("mounts with mount_webdav reading the credentials from fd 3, not from its arguments", async () => {
    const cfg = await davBox();
    const bin = tmpDir();
    const log = path.join(bin, "log");
    fs.writeFileSync(
      path.join(bin, "mount_webdav"),
      `#!/bin/sh\necho "argv: $*" >> '${log}'\nod -An -tx1 <&3 | tr -d ' \\n' >> '${log}'\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "umount"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const home = tmpDir();
    const mountpoint = path.join(home, "mnt");
    const stdout = capture();
    const ctrlC = new AbortController();
    const running = runCli(["mount", mountpoint], { configDir: cfg, stdout, signal: ctrlC.signal, platform: "darwin", env: { PATH: `${bin}:${process.env.PATH}` } });
    await until(() => stdout.text() !== "");
    expect(stdout.text()).toMatch(/^Mounted test at /);
    ctrlC.abort();
    expect((await running).code).toBe(0);
    const [argv = "", hex = ""] = fs.readFileSync(log, "utf8").split("\n");
    expect(argv).toMatch(/^argv: -S -a 3 -v test http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/ /);
    const record = Buffer.from(hex, "hex");
    const userLen = record.readUInt32BE(0);
    expect(record.subarray(4, 4 + userLen).toString()).toBe("agentbox");
    const passLen = record.readUInt32BE(4 + userLen);
    const password = record.subarray(8 + userLen, 8 + userLen + passLen).toString();
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(argv).not.toContain(password);
  });
});
