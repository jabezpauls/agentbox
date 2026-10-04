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
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { bundle, freePort, PASSWORD, startStack, USER, which } from "./stack.mjs";

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
// herdr here, past its first-run tour (which would take the keys and clicks the tests send).
fs.mkdirSync(path.join(cliConfig, "herdr"));
fs.writeFileSync(path.join(cliConfig, "herdr", "config.toml"), "onboarding = false\n");
// A laptop with no browser to open: the code is printed instead.
// The stack's sshd is this user's, on a port of its own (the box's is coder's, on 2222).
const cliEnv = {
  PATH: process.env.PATH,
  HOME: cliHome,
  XDG_CONFIG_HOME: cliConfig,
  LANG: "C.UTF-8",
  AGENTBOX_SSH_USER: stack.ssh.user,
  AGENTBOX_SSH_PORT: String(stack.ssh.port),
};
/** A PATH without herdr, for the old attach. */
const noHerdrPath = "/usr/bin:/bin";
const sshConfig = path.join(cliHome, ".ssh", "config");
/** The box's side, as a program in it sees it: its home, its herdr. */
const boxEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_") && !k.startsWith("XDG_"))),
  HOME: stack.home,
  XDG_CONFIG_HOME: path.join(stack.home, ".config"),
};

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
    // …and set up SSH to the box on the way out.
    assert(/ssh-setup: added `Host \S+` in ~\/.ssh\/config/.test(p.text("stderr")), `no SSH setup: ${p.text("stderr")}`);
    const pub = fs.readFileSync(path.join(cliHome, ".ssh", "agentbox_ed25519.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    assert(fs.readFileSync(path.join(stack.home, ".ssh", "authorized_keys"), "utf8").includes(pub), "the key is not in the box's authorized_keys");
    assert((fs.statSync(path.join(stack.home, ".ssh", "authorized_keys")).mode & 0o777) === 0o600, "authorized_keys lost its 0600");
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

  // herdr on the alternate screen, its sidebar drawn.
  const HERDR_UI = /\x1b\[\?1049h[\s\S]*agents/;

  /** herdr in the box, as a program there runs it. */
  const boxHerdr = (...args) => execFileSync("herdr", args, { env: boxEnv, encoding: "utf8", timeout: 20_000 });
  /** Type a command into the box's first pane. */
  const firstPane = () => {
    const pane = /"pane_id"\s*:\s*"([^"]+)"/.exec(boxHerdr("pane", "list"))?.[1];
    assert(pane, "no pane in the box's herdr");
    return pane;
  };
  const inPane = (commandLine) => boxHerdr("pane", "run", firstPane(), commandLine);
  /** Wait for the box's first pane to show `re` (what the program in it saw). */
  const paneShows = async (re, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = boxHerdr("pane", "read", firstPane(), "--source", "recent");
      if (re.test(text)) return;
      if (Date.now() > deadline) throw new Error(`the pane never showed ${re}:\n${text.slice(-600)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  /**
   * A pane copies `b64` (OSC 52) until the copy shows in what `p` printed:
   * the first may land before a newly attached client is listening.
   */
  const copyReaches = async (p, b64) => {
    const seen = () => p.text().includes(`;${b64}`) && new RegExp(`\\x1b\\]52;[a-z]*;${b64}`).test(p.text());
    for (let i = 0; i < 12 && !seen(); i++) {
      inPane(String.raw`printf '\033]52;c;` + b64 + String.raw`\a'`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    assert(seen(), `the pane's copy never reached this terminal:\n${p.text().slice(-600)}`);
  };
  // The echo programs below each say what they got under a number of their
  // own, so waiting for one's answer is never satisfied by an earlier one's
  // still in the pane, and the next command is never typed while it runs.
  // Each reads once, and a report still on its way when it turns the mouse
  // off (the second of two clicks, say) would reach the shell as typed text
  // and garble the next command: what arrives in the half second after is
  // thrown away before it answers.
  let echoes = 0;
  const DRAIN = `time.sleep(0.5);termios.tcflush(0,termios.TCIFLUSH);`;
  // A program that asks for mouse reports, and says what it got.
  const mouseEcho = () => {
    const n = ++echoes;
    inPane(
      `python3 -c 'import os,tty,select,time,termios;tty.setraw(0);os.write(1,b"\\033[?1000h\\033[?1006h");r=select.select([0],[],[],8)[0];` +
        `d=os.read(0,99) if r else b"";os.write(1,b"\\033[?1000l\\033[?1006l");${DRAIN}os.write(1,b"\\r\\nGOT${n} "+repr(d).encode()+b"\\r\\n")'`,
    );
    return n;
  };
  const CLICK = "\x1b[<0;100;12M\x1b[<0;100;12m";
  const clicked = (n) => new RegExp(String.raw`GOT${n} b'\\x1b\[<0;\d+;\d+M`);
  // A full-screen program with the mouse modes Claude Code's fullscreen
  // renderer asks for, and says what a wheel notch reached it as.
  const wheelEcho = (seconds) => {
    const n = ++echoes;
    inPane(
      `python3 -c 'import os,tty,select,time,termios;tty.setraw(0);on=b"\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1003h\\033[?1006h";os.write(1,on);` +
        `r=select.select([0],[],[],${seconds})[0];d=os.read(0,99) if r else b"";` +
        `os.write(1,b"\\033[?1006l\\033[?1003l\\033[?1002l\\033[?1000l\\033[?1049l");${DRAIN}os.write(1,b"\\r\\nGOT${n} "+repr(d).encode()+b"\\r\\n")'`,
    );
    return n;
  };
  const WHEEL_UP = "\x1b[<64;100;12M";
  const wheeled = (n) => new RegExp(String.raw`GOT${n} b'\\x1b\[<64;\d+;\d+M`);

  await step("attach", "--web: herdr's TUI through the gate, then Ctrl-] q", async () => {
    const p = start(["attach", "--web"], { env: { COLUMNS: "120", LINES: "36" } });
    await p.waitFor(HERDR_UI);
    p.child.stdin.write("\x1d");
    p.child.stdin.write("q");
    const code = await p.exit();
    assert(code === 0, `attach exited ${code}: ${p.text("stderr")}`);
    assert(p.text("stderr").includes("[detached]"), p.text("stderr"));
  });

  await step("attach", "without herdr here: the TUI through the gate; detaches with kitty-protocol keys", async () => {
    const p = start(["attach"], { env: { COLUMNS: "120", LINES: "36", PATH: noHerdrPath } });
    await p.waitFor(HERDR_UI);
    // Ctrl-] pressed and released, then q, in kitty's keyboard protocol.
    p.child.stdin.write("\x1b[93;5u");
    p.child.stdin.write("\x1b[93;5:3u");
    p.child.stdin.write("\x1b[113u");
    const code = await p.exit();
    assert(code === 0 && p.text("stderr").includes("[detached]"), `attach exited ${code}: ${p.text("stderr")}`);
    assert(/Tip: install herdr here/.test(p.text("stderr")), `no hint to install herdr: ${p.text("stderr")}`);
  });

  await step("attach", "in a real terminal: raw mode, clicks and copies pass, and the screen put back", async () => {
    if (!which("script")) throw new Error("util-linux `script` is needed to give the CLI a terminal");
    const cmd = `stty cols 120 rows 36; ${process.execPath} ${bundle} attach; echo "stty after: $(stty -a | tr '\\n' ' ')"`;
    const p = start(["-qfec", cmd, "/dev/null"], { command: "script", env: { PATH: noHerdrPath, SHELL: "/bin/sh" } });
    // In a terminal, with no herdr here, it offers to install it: not now.
    await p.waitFor(/Install it now with herdr's installer .*\? \[y\/N\] /);
    p.child.stdin.write("n\r");
    await p.waitFor(HERDR_UI);
    await copyReaches(p, Buffer.from("e2e-copy-web").toString("base64"));
    const echo = mouseEcho();
    await new Promise((r) => setTimeout(r, 1000));
    p.child.stdin.write(CLICK + CLICK);
    await paneShows(clicked(echo));
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

  // --- the box as an SSH host --------------------------------------------------

  const boxName = () => readConfig().current;
  const ssh = (args, opts = {}) => cli(["-F", sshConfig, ...args], { command: "ssh", timeoutMs: 30_000, ...opts });

  await step("ssh", "ssh <box> through the ProxyCommand and the gate's tunnel, and agentbox ssh", async () => {
    let r = await ssh([boxName(), "echo", "MARK", "$HOME"]);
    assert(r.code === 0 && r.stdout.trim() === `MARK ${stack.home}`, `ssh: ${r.code} ${r.stdout}${r.stderr}`);
    r = await cli(["ssh", "echo", "VIA-CLI"]);
    assert(r.code === 0 && r.stdout.trim() === "VIA-CLI", `agentbox ssh: ${r.code} ${r.stdout}${r.stderr}`);
    // The host key is the box's own, pinned, and checked.
    assert(fs.readFileSync(path.join(cliHome, ".ssh", "agentbox_known_hosts"), "utf8").startsWith(`agentbox-${boxName()} ssh-ed25519 `), "no pinned host key");
    r = await ssh(["-o", "HostKeyAlias=agentbox-someone-else", boxName(), "true"]);
    assert(r.code !== 0 && /Host key verification failed|No ED25519 host key is known/.test(r.stderr), `an unpinned host key was accepted: ${r.stderr}`);
  });

  await step("ssh", "rsync over it", async () => {
    if (!which("rsync")) throw new Skip("no rsync here");
    const src = path.join(stack.root, "rsync-src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "a.txt"), "synced");
    const r = await cli(["-a", "-e", `ssh -F ${sshConfig}`, `${src}/`, `${boxName()}:${stack.workspace}/synced/`], { command: "rsync", timeoutMs: 30_000 });
    assert(r.code === 0, `rsync: ${r.code} ${r.stderr}`);
    assert(fs.readFileSync(path.join(stack.workspace, "synced", "a.txt"), "utf8") === "synced", "rsync did not arrive");
  });

  await step("ssh", "herdr machine add <box>, and herdr --machine lists the box's workspaces", async () => {
    let r = await cli(["herdr", "add"], { timeoutMs: 60_000 });
    assert(r.code === 0 && /Saved SSH machine/.test(r.stdout + r.stderr), `herdr add: ${r.code} ${r.stdout}${r.stderr}`);
    r = await cli(["--machine", boxName(), "workspace", "list"], { command: "herdr", timeoutMs: 60_000 });
    assert(r.code === 0, `herdr --machine: ${r.code} ${r.stdout}${r.stderr}`);
    const mine = JSON.parse(boxHerdr("workspace", "list")).result.workspaces.map((w) => w.workspace_id);
    const theirs = JSON.parse(r.stdout).result.workspaces.map((w) => w.workspace_id);
    assert(mine.length > 0 && JSON.stringify(mine) === JSON.stringify(theirs), `not the box's session: ${JSON.stringify(theirs)} vs ${JSON.stringify(mine)}`);
  });

  await step("ssh", "attach: herdr --remote draws here; clicks and copies pass; Ctrl-b q detaches", async () => {
    if (!which("script")) throw new Error("util-linux `script` is needed to give the CLI a terminal");
    const cmd = `stty cols 120 rows 36; ${process.execPath} ${bundle} attach; echo "exit $?"`;
    const p = start(["-qfec", cmd, "/dev/null"], { command: "script", env: { SHELL: "/bin/sh" } });
    await p.waitFor(/\x1b\[\?1049h/, "stdout", 60_000);
    await new Promise((r) => setTimeout(r, 2000));
    await copyReaches(p, Buffer.from("e2e-copy-ssh").toString("base64"));
    const echo = mouseEcho();
    await new Promise((r) => setTimeout(r, 1000));
    p.child.stdin.write(CLICK + CLICK);
    await paneShows(clicked(echo));
    p.child.stdin.write("\x02");
    await new Promise((r) => setTimeout(r, 200));
    p.child.stdin.write("q");
    const code = await p.exit();
    assert(code === 0 && /exit 0/.test(p.text()), `attach exited ${code}: ${p.text().slice(-800)}`);
  });

  await step("ssh", "attach: the wheel scrolls herdr's scrollback, and reaches a program that took the mouse before herdr --remote attached", async () => {
    // As Claude Code's fullscreen renderer does: it asks for the mouse once, at
    // start, long before the owner's herdr attaches.
    const echo = wheelEcho(30);
    await new Promise((r) => setTimeout(r, 1000));
    const cmd = `stty cols 120 rows 36; ${process.execPath} ${bundle} attach; echo "exit $?"`;
    const p = start(["-qfec", cmd, "/dev/null"], { command: "script", env: { SHELL: "/bin/sh" } });
    await p.waitFor(/\x1b\[\?1049h/, "stdout", 60_000);
    await new Promise((r) => setTimeout(r, 2000));
    p.child.stdin.write(WHEEL_UP);
    await paneShows(wheeled(echo));
    // Back on the normal screen, the wheel scrolls herdr's scrollback, and a
    // key brings the pane back to live.
    inPane("seq 1 500");
    const offset = () => JSON.parse(boxHerdr("pane", "get", firstPane())).result.pane.scroll?.offset_from_bottom ?? 0;
    await new Promise((r) => setTimeout(r, 1000));
    p.child.stdin.write(WHEEL_UP + WHEEL_UP + WHEEL_UP);
    for (let i = 0; i < 50 && offset() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert(offset() > 0, "the wheel did not scroll the pane's scrollback");
    p.child.stdin.write(" ");
    for (let i = 0; i < 50 && offset() !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert(offset() === 0, "typing did not bring the pane back to live");
    p.child.stdin.write("\x02");
    await new Promise((r) => setTimeout(r, 200));
    p.child.stdin.write("q");
    const code = await p.exit();
    assert(code === 0 && /exit 0/.test(p.text()), `attach exited ${code}: ${p.text().slice(-800)}`);
  });

  await step("ssh", "--via <host>: ssh to the host, then the box's sshd over docker exec", async () => {
    fs.appendFileSync(
      sshConfig,
      [
        "",
        "Host e2e-host",
        "  HostName 127.0.0.1",
        `  Port ${stack.ssh.port}`,
        `  User ${stack.ssh.user}`,
        `  IdentityFile ${path.join(cliHome, ".ssh", "agentbox_ed25519")}`,
        "  StrictHostKeyChecking no",
        "  UserKnownHostsFile /dev/null",
        "  LogLevel ERROR",
        "",
      ].join("\n"),
    );
    let r = await cli(["ssh-setup", "--via", "e2e-host"], { timeoutMs: 60_000 });
    assert(r.code === 0 && /through e2e-host \(compose project agentbox-e2e\)/.test(r.stdout), `ssh-setup --via: ${r.code} ${r.stdout}${r.stderr}`);
    assert(/ProxyCommand ssh .*e2e-host 'sh -c /.test(fs.readFileSync(sshConfig, "utf8")), "the block does not go through the host");
    r = await ssh([boxName(), "echo", "FAST", "$HOME"]);
    assert(r.code === 0 && r.stdout.trim() === `FAST ${stack.home}`, `ssh via the host: ${r.code} ${r.stdout}${r.stderr}`);
    r = await cli(["ssh-setup", "--tunnel"]);
    assert(r.code === 0 && /through its HTTPS tunnel/.test(r.stdout), `ssh-setup --tunnel: ${r.stdout}${r.stderr}`);
    r = await ssh([boxName(), "echo", "BACK"]);
    assert(r.code === 0 && r.stdout.trim() === "BACK", `ssh after --tunnel: ${r.code} ${r.stdout}${r.stderr}`);
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
    const { url, user, password } = JSON.parse(line);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/.test(url), url);
    assert(user === "agentbox" && /^[A-Za-z0-9_-]{32}$/.test(password), `credentials: ${user} ${password}`);
    const basic = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    const dav = async (method, rel, headers = {}, body) => {
      const res = await fetch(new URL(rel, url), { method, headers: { authorization: basic, ...headers }, body });
      return { status: res.status, text: await res.text(), headers: res.headers };
    };
    try {
      // Without the password: nothing, and nothing reaches the box.
      let r = await dav("PROPFIND", "", { depth: "1", authorization: "" });
      assert(r.status === 401 && /^Basic /.test(r.headers.get("www-authenticate") ?? ""), `PROPFIND without the password: ${r.status}`);
      r = await dav("PROPFIND", "", { depth: "1" });
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
        // rclone takes a password only obscured, which rclone itself does.
        const obscured = spawnSync("docker", ["run", "--rm", "rclone/rclone:latest", "obscure", password], { encoding: "utf8" }).stdout.trim();
        const remote = `:webdav,url='${url}',vendor=other,user=${user},pass='${obscured}':`;
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

  // --- part two: tunnels, apps, agents, reviews, herdr -----------------------

  // A dev server "in the box" (the stack runs on this machine) and its app.
  const appServer = http.createServer((req, res) => res.end(`hello from the app ${req.url}`));
  const appPort = await freePort();
  await new Promise((r) => appServer.listen(appPort, "127.0.0.1", r));
  let appId = "";

  /** Run a long-lived command until `ready` shows on stdout, then `fn`, then Ctrl-C it. */
  async function whileRunning(args, ready, fn) {
    const p = start(args);
    p.child.stdin.end();
    await p.waitFor(ready);
    try {
      await fn(p);
    } finally {
      p.child.kill("SIGINT");
      const code = await p.exit();
      assert(code === 0, `${args.join(" ")} exited ${code}: ${p.text("stderr")}`);
    }
  }

  await step("forward", "a port in the box at localhost here, through the real tunnel", async () => {
    const local = await freePort();
    await whileRunning(["forward", `${appPort}:${local}`], /http:\/\/localhost:\d+/, async () => {
      const body = await (await fetch(`http://127.0.0.1:${local}/x?y=1`)).text();
      assert(body === "hello from the app /x?y=1", body);
    });
  });

  await step("apps", "ls, forward, share with a link and a passcode, unshare", async () => {
    const made = await gate("POST", "/_gate/apps", { port: appPort, name: "e2e-app" });
    assert(made.status === 201, `making the app: ${made.status} ${made.text}`);
    appId = made.json().id;
    let r = await cli(["apps", "ls", "--json"]);
    const listed = JSON.parse(r.stdout).find((a) => a.id === appId);
    assert(listed && listed.port === appPort && listed.url === `${stack.url}/a/${appId}/`, r.stdout);
    const local = await freePort();
    await whileRunning(["apps", "forward", "e2e-app", String(local)], /http:\/\/localhost:\d+/, async () => {
      const body = await (await fetch(`http://127.0.0.1:${local}/`)).text();
      assert(body === "hello from the app /", body);
    });
    const anonymous = () => fetch(`${stack.url}/a/${appId}/`, { headers: { accept: "application/json" } });
    assert((await anonymous()).status === 404, "private app reachable before sharing");
    r = await cli(["apps", "share", "e2e-app", "--expires", "1h"]);
    assert(r.code === 0 && r.stdout.trim() === `${stack.url}/a/${appId}/`, `share: ${r.stdout}${r.stderr}`);
    const shared = await anonymous();
    assert(shared.status === 200 && (await shared.text()).startsWith("hello from the app"), `shared app: ${shared.status}`);
    r = await cli(["apps", "share", "e2e-app", "--passcode"]);
    assert(r.code === 0 && /passcode {2}\S{8,}/.test(r.stdout), `share --passcode: ${r.stdout}${r.stderr}`);
    r = await cli(["apps", "unshare", "e2e-app"]);
    assert(r.code === 0, r.stderr);
    assert((await anonymous()).status === 404, "the app stayed public after unshare");
  });

  await step("agents", "agents ls and review ls/open", async () => {
    let r = await cli(["agents", "ls", "--json"]);
    assert(r.code === 0 && Array.isArray(JSON.parse(r.stdout)), `agents ls: ${r.stdout}${r.stderr}`);
    r = await cli(["review", "ls", "--json"]);
    assert(r.code === 0 && Array.isArray(JSON.parse(r.stdout)), `review ls: ${r.stdout}${r.stderr}`);
    r = await cli(["review", "open", "no-such-review", "--print"]);
    assert(r.code === 4, `review open of nothing: ${r.code}`);
  });

  await step("herdr", "herdr call and herdr socket, against the box's herdr", async () => {
    let r = await cli(["herdr", "call", "session.snapshot"]);
    assert(r.code === 0 && Array.isArray(JSON.parse(r.stdout).snapshot?.workspaces), `herdr call: ${r.stdout.slice(0, 300)}${r.stderr}`);
    r = await cli(["herdr", "call", "no.such.method"]);
    assert(r.code === 1 && /herdr:/.test(r.stderr), `herdr call of nothing: ${r.code} ${r.stderr}`);
    const where = path.join(stack.root, "herdr-here.sock");
    await whileRunning(["herdr", "socket", where], /herdr-here\.sock/, async () => {
      const line = await new Promise((resolve, reject) => {
        const c = net.connect(where, () => c.write('{"id":"e2e","method":"ping","params":{}}\n'));
        let buf = "";
        c.on("data", (d) => {
          buf += d;
          if (buf.includes("\n")) {
            resolve(buf.split("\n")[0]);
            c.destroy();
          }
        });
        c.once("error", reject);
      });
      const answer = JSON.parse(line);
      assert(answer.id === "e2e" && !answer.error, line);
    });
  });
  appServer.close();

  // --- sign out --------------------------------------------------------------------

  await step("logout", "revokes this device's token at the box", async () => {
    const name = boxName();
    const r = await cli(["logout"]);
    assert(r.code === 0 && /token is revoked/.test(r.stdout), `logout: ${r.stdout}${r.stderr}`);
    // …and the SSH setup with it: the key off the box, the block and the pin gone here.
    const pub = fs.readFileSync(path.join(cliHome, ".ssh", "agentbox_ed25519.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    assert(!fs.readFileSync(path.join(stack.home, ".ssh", "authorized_keys"), "utf8").includes(pub), "the key is still in the box's authorized_keys");
    assert(!fs.readFileSync(sshConfig, "utf8").includes(`Host ${name}\n`), "the Host block is still in ~/.ssh/config");
    assert(fs.readFileSync(sshConfig, "utf8").includes("Host e2e-host"), "logout took the person's own hosts too");
    assert(!fs.readFileSync(path.join(cliHome, ".ssh", "agentbox_known_hosts"), "utf8").includes(`agentbox-${name} `), "the host key is still pinned");
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
