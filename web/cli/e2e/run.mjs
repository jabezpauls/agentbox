#!/usr/bin/env node
// The CLI end to end: the built bundle (dist/agentbox.mjs) against the local
// stack in stack.mjs — herdr, the bridge, ttyd and the gate, all real. It signs
// in through the device flow (approved through the gate's API with a real
// session and the password, as the approval page does), then drives every
// part-one command the way a person would, and checks the result on the
// box's side (the workspace folder, the gate's token list).
//
//   npm run build            (in web/)
//   npm run e2e -w cli       [-- --keep] [-- --only files,mount]
//
// Needs herdr and ttyd (1.7.7, as the image pins; TTYD=/path overrides) on
// PATH. With Docker it also runs rclone against `mount --no-mount` and the
// install script in a clean node:22 container (E2E_DOCKER=0 skips both).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bundle, PASSWORD, startStack, USER, which } from "./stack.mjs";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice(7) ?? (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null);
const only = onlyArg ? new Set(onlyArg.split(",")) : null;
const docker = process.env.E2E_DOCKER !== "0" && which("docker") !== null;

let failures = 0;
const results = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

class Skip extends Error {}

async function step(group, name, fn) {
  if (only && !only.has(group)) return;
  const t = Date.now();
  try {
    await fn();
    results.push(["ok", `${group}: ${name}`]);
    console.log(`ok    ${group}: ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    if (err instanceof Skip) {
      results.push(["skip", `${group}: ${name}`]);
      console.log(`skip  ${group}: ${name} (${err.message})`);
      return;
    }
    failures += 1;
    results.push(["FAIL", `${group}: ${name}`]);
    console.log(`FAIL  ${group}: ${name}\n      ${String(err.stack ?? err).split("\n").join("\n      ")}`);
  }
}

const stack = await startStack({ log: () => {} });
console.log(`stack up at ${stack.url} (state in ${stack.root})`);

const cliHome = path.join(stack.root, "laptop");
const cliConfig = path.join(cliHome, ".config");
fs.mkdirSync(cliConfig, { recursive: true });
// A laptop with no browser to open: the code is printed instead.
const cliEnv = { PATH: process.env.PATH, HOME: cliHome, XDG_CONFIG_HOME: cliConfig, LANG: "C.UTF-8" };

/** Start the CLI; collect what it prints; wait for things in it. */
function start(args, opts = {}) {
  const child = spawn(opts.command ?? process.execPath, opts.command ? args : [bundle, ...args], {
    env: { ...cliEnv, ...(opts.env ?? {}) },
    cwd: opts.cwd ?? cliHome,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  child.stdout.on("data", (c) => (out.stdout = Buffer.concat([out.stdout, c])));
  child.stderr.on("data", (c) => (out.stderr = Buffer.concat([out.stderr, c])));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? 128 + (signal === "SIGINT" ? 2 : 15))));
  return {
    child,
    out,
    text: (s = "stdout") => out[s].toString("utf8"),
    async waitFor(re, s = "stdout", timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const m = re.exec(out[s].toString("utf8"));
        if (m) return m;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${re} on ${s}; got:\n${out[s].toString("utf8").slice(-2000)}\n--- stderr:\n${out.stderr.toString("utf8").slice(-2000)}`);
        if (child.exitCode !== null) throw new Error(`exited ${child.exitCode} before ${re} on ${s}:\n${out.stderr.toString("utf8")}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async exit(timeoutMs = 30_000) {
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

/** Run the CLI to completion. */
async function cli(args, opts = {}) {
  const p = start(args, opts);
  if (opts.input !== undefined) p.child.stdin.end(opts.input);
  else p.child.stdin.end();
  const code = await p.exit(opts.timeoutMs);
  return { code, stdout: p.text("stdout"), stderr: p.text("stderr") };
}

// --- the owner, in a browser: a session on the gate ----------------------------

let cookie = "";
async function gate(method, p, body) {
  const res = await fetch(`${stack.url}${p}`, {
    method,
    headers: { origin: stack.url, cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: () => JSON.parse(text), text };
}
{
  const res = await gate("POST", "/_gate/login", { username: USER, password: PASSWORD });
  assert(res.status === 200, `session sign-in failed: ${res.status} ${res.text}`);
  cookie = res.headers.get("set-cookie").split(";")[0];
}

/** Approve a device login as the approval page does: signed in, with the password. */
async function approve(userCode, expectName) {
  const pending = await gate("GET", `/_gate/device/pending?code=${userCode}`);
  assert(pending.status === 200, `no pending login for ${userCode}: ${pending.text}`);
  if (expectName) assert(pending.json().name === expectName, `pending login is named ${pending.json().name}`);
  const res = await gate("POST", "/_gate/device/approve", { userCode, password: PASSWORD });
  assert(res.status === 200, `approval failed: ${res.status} ${res.text}`);
}

const CODE = /\b([B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4})\b/;
const configFile = path.join(cliConfig, "agentbox", "config.json");
const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
let token = "";

try {
  // --- sign in ---------------------------------------------------------------

  await step("login", "device flow, approved in the browser session", async () => {
    const p = start(["login", stack.url, "--no-browser", "--device", "e2e laptop"]);
    const [, userCode] = await p.waitFor(CODE, "stderr");
    assert(p.text("stderr").includes(`${stack.url}/settings/devices?code=${userCode}`), "the approval URL was not printed");
    await approve(userCode, "e2e laptop");
    const code = await p.exit();
    assert(code === 0, `login exited ${code}: ${p.text("stderr")}`);
    assert(/Signed in to .* as e2e/.test(p.text("stdout")), `unexpected output: ${p.text("stdout")}`);
    const cfg = readConfig();
    const box = cfg.boxes[cfg.current];
    token = box.token;
    assert(/^abx_[A-Za-z0-9_-]{43}$/.test(token), "no device token in the config");
    assert(!p.text("stdout").includes(token) && !p.text("stderr").includes(token), "the token was printed");
    assert((fs.statSync(configFile).mode & 0o777) === 0o600, `config mode is ${(fs.statSync(configFile).mode & 0o777).toString(8)}`);
    assert((fs.statSync(path.dirname(configFile)).mode & 0o777) === 0o700, "config folder is not 0700");
    const tokens = (await gate("GET", "/_gate/tokens")).json();
    assert(tokens.some((t) => t.name === "e2e laptop"), "the gate does not list the device");
  });

  await step("login", "whoami", async () => {
    const r = await cli(["whoami", "--json"]);
    assert(r.code === 0, r.stderr);
    const who = JSON.parse(r.stdout);
    assert(who.user === USER && who.device === "e2e laptop" && who.url === stack.url, r.stdout);
    assert(!r.stdout.includes(token), "the token was printed");
  });

  await step("status", "box, herdr, agents and system", async () => {
    const r = await cli(["status", "--json"]);
    assert(r.code === 0, `status exited ${r.code}: ${r.stderr}\n${r.stdout}`);
    const s = JSON.parse(r.stdout);
    assert(s.box.user === USER && typeof s.box.version === "string", r.stdout);
    assert(s.herdr?.connected === true, `herdr: ${JSON.stringify(s.herdr)}`);
    assert(Array.isArray(s.agents), `agents: ${JSON.stringify(s.agents)}`);
    assert(typeof s.system?.sandbox?.memory === "number" && Array.isArray(s.system.disks), `system: ${JSON.stringify(s.system)}`);
    const human = await cli(["status"]);
    assert(human.code === 0 && /herdr\s+connected/.test(human.stdout) && /system\s+/.test(human.stdout), human.stdout + human.stderr);
  });

  // --- terminals ---------------------------------------------------------------

  const HERDR_UI = /terminal workspace manager/;

  await step("attach", "herdr's TUI through the gate, then Ctrl-] q", async () => {
    const p = start(["attach"], { env: { COLUMNS: "120", LINES: "36" } });
    await p.waitFor(HERDR_UI);
    p.child.stdin.write("\x1d");
    p.child.stdin.write("q");
    const code = await p.exit();
    assert(code === 0, `attach exited ${code}: ${p.text("stderr")}`);
    assert(p.text("stderr").includes("[detached]"), p.text("stderr"));
  });

  await step("attach", "in a real terminal: raw mode, and the screen put back", async () => {
    if (!which("script")) throw new Error("util-linux `script` is needed to give the CLI a terminal");
    const cmd = `stty cols 120 rows 36; ${process.execPath} ${bundle} attach; echo "stty after: $(stty -a | tr '\\n' ' ')"`;
    const p = start(["-qfec", cmd, "/dev/null"], { command: "script" });
    await p.waitFor(HERDR_UI);
    p.child.stdin.write("\x1d");
    await new Promise((r) => setTimeout(r, 100));
    p.child.stdin.write("q");
    const code = await p.exit();
    const out = p.text();
    assert(code === 0, `script exited ${code}: ${out.slice(-500)}`);
    const after = out.slice(out.lastIndexOf("[detached]"));
    const tail = out.slice(out.search(HERDR_UI));
    // herdr took the alternate screen and the mouse; leaving gave both back.
    assert(tail.includes("\x1b[?1049l") && tail.includes("\x1b[?1000l") && tail.includes("\x1b[?25h"), "the terminal modes were not restored");
    // Cooked mode again: the terminal echoes and takes lines.
    assert(/stty after:/.test(after) && /\sicanon\s/.test(after) && /\secho\s/.test(after), `terminal left raw: ${after}`);
  });

  await step("shell", "bash in the box, started with --cwd", async () => {
    const r = await cli(["shell", "--cwd", "demo"], { input: "echo MARK-$((6*7)) $PWD\rexit\r", env: { COLUMNS: "200", LINES: "40" } });
    assert(r.code === 0, `shell exited ${r.code}: ${r.stderr}`);
    assert(r.stdout.includes(`MARK-42 ${path.join(stack.workspace, "demo")}`), `output: ${r.stdout.slice(-800)}`);
  });

  // --- files ---------------------------------------------------------------------

  const local = path.join(cliHome, "tree");
  const big = randomBytes(3 * 1024 * 1024 + 123);
  const files = {
    "a.txt": "alpha\n",
    "sub/deep/c.txt": "deep\n",
    "spaced name ü.txt": "unicode\n",
    ".hidden": "dot\n",
  };
  fs.mkdirSync(path.join(local, "sub", "deep"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(local, name), body);
  fs.writeFileSync(path.join(local, "big.bin"), big);
  const onBox = (p) => path.join(stack.workspace, p);
  const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

  await step("files", "put -r a folder in chunks, list it, get it back", async () => {
    let r = await cli(["files", "put", "-r", "--chunk-size", "256K", local, "demo"]);
    assert(r.code === 0, `put: ${r.stderr}`);
    for (const name of [...Object.keys(files), "big.bin"]) assert(same(path.join(local, name), onBox(path.join("demo", "tree", name))), `${name} differs on the box`);
    r = await cli(["files", "ls", "--json", "demo/tree"]);
    const names = JSON.parse(r.stdout).entries.map((e) => e.name);
    assert(names.includes("big.bin") && names.includes("spaced name ü.txt") && !names.includes(".hidden"), names.join(","));
    r = await cli(["files", "ls", "-a", "demo/tree"]);
    assert(r.stdout.includes(".hidden") && r.stdout.includes("sub/"), r.stdout);
    const out = path.join(cliHome, "back");
    fs.mkdirSync(out);
    r = await cli(["files", "get", "-r", "demo/tree", out]);
    assert(r.code === 0, `get: ${r.stderr}`);
    for (const name of [...Object.keys(files), "big.bin"]) assert(same(path.join(local, name), path.join(out, "tree", name)), `${name} came back different`);
    r = await cli(["files", "cat", path.join(stack.workspace, "demo", "tree", "a.txt")]);
    assert(r.stdout === "alpha\n", `cat: ${r.stdout}${r.stderr}`);
  });

  await step("files", "mv, cp, mkdir, rm to the trash, put --force", async () => {
    let r = await cli(["files", "mv", "demo/tree/a.txt", "demo/tree/sub"]);
    assert(r.code === 0 && fs.existsSync(onBox("demo/tree/sub/a.txt")) && !fs.existsSync(onBox("demo/tree/a.txt")), `mv: ${r.stderr}`);
    r = await cli(["files", "cp", "demo/tree/sub", "demo/copy"]);
    assert(r.code === 1 && /add -r/.test(r.stderr), `cp without -r: ${r.code} ${r.stderr}`);
    r = await cli(["files", "cp", "-r", "demo/tree/sub", "demo/copy"]);
    assert(r.code === 0 && fs.readFileSync(onBox("demo/copy/deep/c.txt"), "utf8") === "deep\n", `cp: ${r.stderr}`);
    r = await cli(["files", "mkdir", "demo/x/y"]);
    assert(r.code === 0 && fs.statSync(onBox("demo/x/y")).isDirectory(), `mkdir: ${r.stderr}`);
    r = await cli(["files", "put", path.join(local, "sub", "deep", "c.txt"), "demo/tree/sub/a.txt"]);
    assert(r.code === 1 && /add --force/.test(r.stderr), `put over a file: ${r.code} ${r.stderr}`);
    r = await cli(["files", "put", "--force", path.join(local, "sub", "deep", "c.txt"), "demo/tree/sub/a.txt"]);
    assert(r.code === 0 && fs.readFileSync(onBox("demo/tree/sub/a.txt"), "utf8") === "deep\n", `put --force: ${r.stderr}`);
    r = await cli(["files", "rm", "demo/copy"]);
    assert(r.code === 1 && /add -r/.test(r.stderr), `rm without -r: ${r.stderr}`);
    r = await cli(["files", "rm", "-r", "demo/copy"]);
    assert(r.code === 0 && !fs.existsSync(onBox("demo/copy")), `rm: ${r.stderr}`);
    const trash = fs.readdirSync(onBox(".agentbox/trash"));
    assert(trash.length >= 2, `the trash holds ${trash.length} items`);
    r = await cli(["files", "stat", "demo/nothing"]);
    assert(r.code === 4, `stat of nothing: ${r.code}`);
  });

  await step("files", "edit round-trips through $EDITOR", async () => {
    fs.writeFileSync(onBox("demo/conf.txt"), "port=1\n");
    const editor = path.join(cliHome, "editor.sh");
    fs.writeFileSync(editor, "#!/bin/sh\nsed -i 's/port=1/port=2/' \"$1\"\n", { mode: 0o755 });
    const r = await cli(["files", "edit", "demo/conf.txt"], { env: { EDITOR: editor } });
    assert(r.code === 0, `edit: ${r.stderr}`);
    assert(fs.readFileSync(onBox("demo/conf.txt"), "utf8") === "port=2\n", "the edit did not reach the box");
  });

  await step("files", "an interrupted upload resumes where the box left off", async () => {
    const file = path.join(cliHome, "huge.bin");
    fs.writeFileSync(file, randomBytes(48 * 1024 * 1024));
    const uploads = onBox(".agentbox/uploads");
    const partBytes = () => {
      try {
        return fs
          .readdirSync(uploads)
          .filter((n) => n.endsWith(".part"))
          .reduce((n, f) => n + fs.statSync(path.join(uploads, f)).size, 0);
      } catch {
        return 0;
      }
    };
    const p = start(["files", "put", "--chunk-size", "64K", file, "demo/huge.bin"]);
    p.child.stdin.end();
    const deadline = Date.now() + 30_000;
    while (partBytes() < 4 * 1024 * 1024 && Date.now() < deadline && p.child.exitCode === null) await new Promise((r) => setTimeout(r, 10));
    p.child.kill("SIGINT");
    const code = await p.exit();
    assert(code === 130, `the first run exited ${code}: ${p.text("stderr")}`);
    assert(/run the same command again to resume/.test(p.text("stderr")), p.text("stderr"));
    assert(!fs.existsSync(onBox("demo/huge.bin")), "a half upload appeared under its name");
    const r = await cli(["files", "put", "--chunk-size", "8M", file, "demo/huge.bin"], { timeoutMs: 120_000 });
    assert(r.code === 0, `the second run: ${r.stderr}`);
    const m = /resuming at ([\d.]+ \w+) of/.exec(r.stderr);
    assert(m, `it did not resume: ${r.stderr}`);
    assert(same(file, onBox("demo/huge.bin")), "the resumed file differs");
  });

  // --- mount -------------------------------------------------------------------

  await step("mount", "--no-mount serves WebDAV; a client copies, moves and deletes through it", async () => {
    const p = start(["mount", "--no-mount", "--json"]);
    const [line] = await p.waitFor(/\{[\s\S]*\}\n/);
    const { url } = JSON.parse(line);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/.test(url), url);
    const dav = async (method, rel, headers = {}, body) => {
      const res = await fetch(new URL(rel, url), { method, headers, body });
      return { status: res.status, text: await res.text(), headers: res.headers };
    };
    try {
      let r = await dav("PROPFIND", "", { depth: "1" });
      assert(r.status === 207, `PROPFIND ${r.status}`);
      const prefix = new URL(url).pathname;
      assert(r.text.includes(`<D:href>${prefix}demo/</D:href>`), `hrefs not under ${prefix}: ${r.text.slice(0, 500)}`);
      assert(!r.text.includes("/api/dav"), "a box href leaked through");
      r = await dav("MKCOL", "davdir/");
      assert(r.status === 201, `MKCOL ${r.status}`);
      r = await dav("PUT", "davdir/hello%20there.txt", { "content-type": "text/plain" }, "hello from dav\n");
      assert(r.status === 201 || r.status === 204, `PUT ${r.status}`);
      assert(fs.readFileSync(onBox("davdir/hello there.txt"), "utf8") === "hello from dav\n", "PUT did not land");
      r = await dav("GET", "davdir/hello%20there.txt");
      assert(r.text === "hello from dav\n", `GET ${r.text}`);
      r = await dav("COPY", "davdir/hello%20there.txt", { destination: `${url}davdir/copy.txt` });
      assert(r.status === 201, `COPY ${r.status} ${r.text}`);
      r = await dav("MOVE", "davdir/copy.txt", { destination: `${url}davdir/moved;semi.txt`, overwrite: "F" });
      assert(r.status === 201, `MOVE ${r.status} ${r.text}`);
      assert(fs.existsSync(onBox("davdir/moved;semi.txt")) && !fs.existsSync(onBox("davdir/copy.txt")), "MOVE did not land");
      r = await dav("LOCK", "davdir/moved;semi.txt", { "content-type": "application/xml", timeout: "Second-60" },
        '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>');
      assert(r.status === 200, `LOCK ${r.status} ${r.text}`);
      assert(r.text.includes(`<D:href>${prefix}davdir/moved%3Bsemi.txt</D:href>`), `lockroot not rewritten: ${r.text}`);
      const lockToken = r.headers.get("lock-token");
      r = await dav("DELETE", "davdir/moved;semi.txt");
      assert(r.status === 423, `DELETE of a locked file: ${r.status}`);
      r = await dav("DELETE", "davdir/moved;semi.txt", { if: `<${url}davdir/moved;semi.txt> (${lockToken})` });
      assert(r.status === 204, `DELETE with the lock: ${r.status} ${r.text}`);
      assert(!fs.existsSync(onBox("davdir/moved;semi.txt")), "DELETE did not land");
      r = await dav("COPY", "davdir/hello%20there.txt", { destination: "http://elsewhere.example/x" });
      assert(r.status === 502, `COPY elsewhere: ${r.status}`);
      r = await dav("GET", "../");
      assert(r.status === 404, `outside the secret: ${r.status}`);
      if (docker) {
        const data = path.join(stack.root, "rclone-data");
        fs.mkdirSync(path.join(data, "sub"), { recursive: true });
        fs.writeFileSync(path.join(data, "a.txt"), "alpha");
        fs.writeFileSync(path.join(data, "sub", "b.bin"), randomBytes(200_000));
        const remote = `:webdav,url='${url}',vendor=other:`;
        const rc = (...args) => {
          const res = spawnSync("docker", ["run", "--rm", "--network", "host", "-v", `${data}:/data:ro`, "rclone/rclone:latest", ...args], { encoding: "utf8", timeout: 120_000 });
          assert(res.status === 0, `rclone ${args.join(" ")}: ${res.stderr}`);
          return res.stdout;
        };
        rc("copy", "/data", `${remote}rc`);
        rc("check", "/data", `${remote}rc`);
        assert(same(path.join(data, "sub", "b.bin"), onBox("rc/sub/b.bin")), "rclone's copy differs on the box");
        rc("copyto", `${remote}rc/a.txt`, `${remote}rc/a-copy.txt`);
        rc("moveto", `${remote}rc/a-copy.txt`, `${remote}rc/a-moved.txt`);
        assert(fs.readFileSync(onBox("rc/a-moved.txt"), "utf8") === "alpha", "rclone's server-side move");
        rc("deletefile", `${remote}rc/a-moved.txt`);
        assert(!fs.existsSync(onBox("rc/a-moved.txt")), "rclone's delete");
        const listed = rc("lsf", "-R", `${remote}rc`);
        assert(listed.includes("sub/b.bin") && listed.includes("a.txt"), listed);
      }
    } finally {
      p.child.kill("SIGINT");
      const code = await p.exit();
      assert(code === 0, `mount exited ${code}: ${p.text("stderr")}`);
    }
  });

  // --- install and update --------------------------------------------------------

  await step("install", "the box's install script installs the CLI, and update replaces it", async () => {
    const res = await fetch(`${stack.url}/cli/install`);
    const script = await res.text();
    assert(res.status === 200 && script.includes(`BOX='${stack.url}'`), `install script: ${res.status}`);
    const home = path.join(stack.root, "fresh-home");
    fs.mkdirSync(home);
    const sh = spawnSync("sh", ["-s", "--", "--no-login"], { input: script, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    assert(sh.status === 0, `install: ${sh.stderr}`);
    const bin = path.join(home, ".local", "bin", "agentbox");
    const lib = path.join(home, ".local", "share", "agentbox", "agentbox.mjs");
    assert(fs.readlinkSync(bin) === lib && same(lib, bundle), "not installed where it should be");
    assert(/is not on your PATH/.test(sh.stdout) && sh.stdout.includes(`login ${stack.url}`), sh.stdout);
    const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
    assert(/^agentbox \S+$/.test(version), version);
    // The box gets a new build; the installed CLI updates itself from it.
    const served = path.join(stack.gateCli, "agentbox.mjs");
    fs.appendFileSync(served, "\n// a newer build\n");
    const up = spawnSync(bin, ["update"], { env: { ...cliEnv, HOME: home }, encoding: "utf8" });
    assert(up.status === 0 && /Updated agentbox/.test(up.stdout), `update: ${up.stdout}${up.stderr}`);
    assert(same(lib, served) && fs.readlinkSync(bin) === lib, "update did not swap the file in");
    const again = spawnSync(bin, ["update"], { env: { ...cliEnv, HOME: home }, encoding: "utf8" });
    assert(/Already up to date/.test(again.stdout), again.stdout + again.stderr);
  });

  await step("install", "curl … | sh in a clean node:22 container, signing in", async () => {
    if (!docker) throw new Skip("no Docker, or E2E_DOCKER=0");
    const p = start(["run", "--rm", "--network", "host", "node:22", "sh", "-c", `curl -fsSL ${stack.url}/cli/install | sh`], { command: "docker" });
    p.child.stdin.end();
    const [, userCode] = await p.waitFor(CODE, "stderr", 300_000);
    await approve(userCode);
    const code = await p.exit(60_000);
    assert(code === 0, `the container exited ${code}: ${p.text("stdout")}${p.text("stderr")}`);
    assert(/Installed agentbox/.test(p.text("stdout")) && /Signed in to .* as e2e/.test(p.text("stdout")), p.text("stdout"));
  });

  // --- sign out --------------------------------------------------------------------

  await step("logout", "revokes this device's token at the box", async () => {
    const r = await cli(["logout"]);
    assert(r.code === 0 && /token is revoked/.test(r.stdout), `logout: ${r.stdout}${r.stderr}`);
    const res = await fetch(`${stack.url}/_gate/session`, { headers: { authorization: `Bearer ${token}` } });
    assert(res.status === 401, `the old token still works: ${res.status}`);
    assert(!(await gate("GET", "/_gate/tokens")).json().some((t) => t.name === "e2e laptop"), "the gate still lists the device");
    const after = await cli(["whoami"]);
    assert(after.code === 3, `whoami after logout: ${after.code}`);
  });
} finally {
  await stack.stop({ keep });
  if (keep) console.log(`kept ${stack.root}`);
}

const passed = results.filter(([r]) => r === "ok").length;
const skipped = results.filter(([r]) => r === "skip").length;
console.log(`\n${passed} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ""}${docker ? "" : " (no Docker: rclone and the node:22 install were not run)"}`);
if (failures) {
  process.exitCode = 1;
}
