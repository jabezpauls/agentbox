import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { COMMANDS } from "../src/commands/index.js";
import { ConfigStore } from "../src/config.js";
import {
  addAuthorizedKey,
  currentBlock,
  fingerprint,
  parsePublicKey,
  pinHostKey,
  projectWithKey,
  removeAuthorizedKey,
  removeBlock,
  renderBlock,
  shellArg,
  tunnelProxy,
  unpinHostKey,
  upsertBlock,
  viaProxy,
  type PublicKey,
} from "../src/ssh.js";
import { filesStub, put, read, type FilesStub } from "./files-stub.js";
import { runCli, signedIn, tmpDir } from "./helpers.js";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const HOST = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
const key = (line: string): PublicKey => parsePublicKey(line) as PublicKey;

const block = (box: string, proxy = ["/usr/local/bin/agentbox", "proxy", "tcp:2222", "--box", box]): string =>
  renderBlock({ box, user: "coder", proxy, identityFile: "/h/.ssh/id_ed25519", knownHostsFile: "/h/.ssh/agentbox_known_hosts", platform: "linux" });

describe("the managed block in ~/.ssh/config", () => {
  it("goes first, ahead of the person's own hosts, and is found again", () => {
    const mine = "Host *\n  User someone\n\nHost work\n  HostName work.example\n";
    const r = upsertBlock(mine, "box", block("box"));
    expect(r.status).toBe("added");
    expect(r.text.startsWith("# >>> agentbox: box (managed")).toBe(true);
    expect(r.text.endsWith(mine)).toBe(true);
    expect(currentBlock(r.text, "box")).toBe(block("box"));
    expect(upsertBlock(r.text, "box", block("box"))).toEqual({ text: r.text, status: "unchanged" });
    expect(upsertBlock("", "box", block("box")).text).toBe(`${block("box")}\n`);
  });

  it("is replaced in place, leaving other boxes' blocks and everything else alone", () => {
    let text = upsertBlock("Host work\n  User me\n", "box", block("box")).text;
    text = upsertBlock(text, "box-2", block("box-2")).text;
    const moved = block("box", ["/new/agentbox", "proxy", "tcp:2222", "--box", "box"]);
    const r = upsertBlock(text, "box", moved);
    expect(r.status).toBe("updated");
    expect(currentBlock(r.text, "box")).toBe(moved);
    expect(currentBlock(r.text, "box-2")).toBe(block("box-2"));
    expect(r.text).toContain("Host work\n  User me\n");
    expect(r.text.match(/Host box\n/g)).toHaveLength(1);
  });

  it("comes out whole, leaving the rest as it was", () => {
    const mine = "Host work\n  User me\n";
    let text = upsertBlock(mine, "box", block("box")).text;
    text = upsertBlock(text, "box-2", block("box-2")).text;
    const r = removeBlock(text, "box");
    expect(r.removed).toBe(true);
    expect(currentBlock(r.text, "box")).toBeNull();
    expect(r.text).toBe(upsertBlock(mine, "box-2", block("box-2")).text);
    expect(removeBlock(r.text, "box").removed).toBe(false);
    expect(removeBlock(upsertBlock(mine, "box", block("box")).text, "box").text).toBe(mine);
  });

  it("refuses a block whose end marker was lost, rather than guess", () => {
    const broken = block("box").split("\n").slice(0, -1).join("\n");
    expect(() => upsertBlock(broken, "box", block("box"))).toThrow(/end/);
  });

  it("quotes the ProxyCommand for the shell ssh runs it with, and escapes %", () => {
    const b = block("box", ["/Users/Jo Doe/bin/agentbox", "proxy", "tcp:2222", "--box", "box"]);
    expect(b).toContain("  ProxyCommand '/Users/Jo Doe/bin/agentbox' proxy tcp:2222 --box box\n");
    expect(block("box", ["/tmp/100%/agentbox"])).toContain("ProxyCommand /tmp/100%%/agentbox\n");
    expect(shellArg("it's", "linux")).toBe(`'it'\\''s'`);
    expect(shellArg("C:\\Program Files\\node.exe", "win32")).toBe('"C:\\Program Files\\node.exe"');
    expect(b).toMatch(/HostKeyAlias agentbox-box\n {2}UserKnownHostsFile \/h\/.ssh\/agentbox_known_hosts\n {2}StrictHostKeyChecking yes/);
    expect(tunnelProxy(["agentbox"], 2222, "b")).toEqual(["agentbox", "proxy", "tcp:2222", "--box", "b"]);
  });

  it("goes through the host with --via: ssh there, then the box's sshd over docker exec", () => {
    const words = viaProxy("fludigo", "agentbox", ["-F", "/h/.ssh/config"]);
    expect(words.slice(0, 7)).toEqual(["ssh", "-F", "/h/.ssh/config", "-T", "-o", "ClearAllForwardings=yes", "--"]);
    expect(words[7]).toBe("fludigo");
    expect(words[8]).toMatch(/^sh -c '.*label=com\.docker\.compose\.project=agentbox -f label=com\.docker\.compose\.service=ssh.*exec docker exec -i "\$c" agentbox-sshd -i'$/);
    expect(() => viaProxy("-oProxyCommand=x", "agentbox")).toThrow(/not an ssh host/);
    expect(() => viaProxy("fludigo", "Bad;name")).toThrow(/compose project/);
    const answer = `other ${KEY_A} root@x\nagentbox-2 ${HOST} agentbox\njunk\n`;
    expect(projectWithKey(answer, key(HOST))).toBe("agentbox-2");
    expect(projectWithKey(answer, key(KEY_B))).toBeNull();
  });
});

describe("keys", () => {
  it("are added to authorized_keys once, whatever options or comment a line has", () => {
    const k = key(`${KEY_A} me@laptop`);
    const first = addAuthorizedKey("", k);
    expect(first).toEqual({ text: `${KEY_A} me@laptop\n`, added: true });
    expect(addAuthorizedKey(first.text, k).added).toBe(false);
    expect(addAuthorizedKey(`no-pty,from="10.0.0.1" ${KEY_A} other-comment`, k).added).toBe(false);
    const two = addAuthorizedKey(KEY_B, k);
    expect(two).toEqual({ text: `${KEY_B}\n${KEY_A} me@laptop\n`, added: true });
  });

  it("pin the box's host key under its alias alone, replacing an old one", () => {
    const h = key(HOST);
    const a = pinHostKey("agentbox-other ssh-ed25519 AAAA\n", "agentbox-box", h);
    expect(a.status).toBe("added");
    expect(pinHostKey(a.text, "agentbox-box", h).status).toBe("unchanged");
    const r = pinHostKey(a.text, "agentbox-box", key(KEY_A));
    expect(r.status).toBe("replaced");
    expect(r.text).toBe(`agentbox-other ssh-ed25519 AAAA\nagentbox-box ${KEY_A}\n`);
  });

  it("come out of authorized_keys and known_hosts by key and alias alone", () => {
    const k = key(KEY_A);
    expect(removeAuthorizedKey(`${KEY_B} x\nno-pty ${KEY_A} me\n`, k)).toEqual({ text: `${KEY_B} x\n`, removed: true });
    expect(removeAuthorizedKey(`${KEY_B}\n`, k).removed).toBe(false);
    expect(unpinHostKey(`agentbox-a ${KEY_A}\nagentbox-ab ${KEY_B}\n`, "agentbox-a")).toEqual({ text: `agentbox-ab ${KEY_B}\n`, removed: true });
  });

  it("from the box are read strictly, and fingerprinted as ssh-keygen does", () => {
    expect(parsePublicKey("ssh-ed25519 AAAA\nHost evil")).toBeNull();
    expect(parsePublicKey("<html>")).toBeNull();
    expect(fingerprint(key(KEY_A))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe("arguments for another program", () => {
  it("pass through after the command's own and the global options", () => {
    const p = parseArgs(["attach", "--box", "b", "--session", "work", "-h"], COMMANDS);
    expect(p.command?.path).toEqual(["attach"]);
    expect(p.globals.box).toBe("b");
    expect(p.globals.help).toBe(false);
    expect(p.operands).toEqual(["--session", "work", "-h"]);
    const web = parseArgs(["attach", "--web"], COMMANDS);
    expect(web.options.web).toBe(true);
    expect(parseArgs(["ssh", "ls", "-la"], COMMANDS).operands).toEqual(["ls", "-la"]);
    expect(parseArgs(["attach", "--help"], COMMANDS).globals.help).toBe(true);
  });
});

describe("agentbox ssh-setup", () => {
  const stubs: FilesStub[] = [];
  afterEach(async () => {
    while (stubs.length) await stubs.pop()?.close();
  });

  async function setup(): Promise<{ stub: FilesStub; cfg: string; home: string }> {
    const stub = await filesStub();
    stubs.push(stub);
    put(stub, "/home/coder/.agentbox/ssh/ssh_host_ed25519_key.pub", `${HOST} agentbox\n`);
    put(stub, "/home/coder/.ssh", null);
    put(stub, "/home/coder/.ssh/authorized_keys", `${KEY_B} someone-else\n`);
    return { stub, cfg: signedIn(stub.url), home: tmpDir() };
  }

  it("uses the person's key, installs it once, pins the host key, writes the block, and says so", async () => {
    const { stub, cfg, home } = await setup();
    fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "private");
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519.pub"), `${KEY_A} me@laptop\n`);
    fs.writeFileSync(path.join(home, ".ssh", "config"), "Host work\n  User me\n");
    const r = await runCli(["ssh-setup"], { configDir: cfg, env: { HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/added ~\/.ssh\/id_ed25519.pub to ~\/.ssh\/authorized_keys on test/);
    expect(r.stdout).toMatch(/pinned test's host key SHA256:/);
    expect(r.stdout).toMatch(/added `Host test` in ~\/.ssh\/config/);
    expect(read(stub, "/home/coder/.ssh/authorized_keys")).toBe(`${KEY_B} someone-else\n${KEY_A} me@laptop\n`);
    const config = fs.readFileSync(path.join(home, ".ssh", "config"), "utf8");
    expect(config).toMatch(/^# >>> agentbox: test /);
    expect(config).toContain(`  IdentityFile ${path.join(home, ".ssh", "id_ed25519")}\n`);
    expect(config).toMatch(/ProxyCommand .* proxy tcp:2222 --box test\n/);
    expect(config.endsWith("Host work\n  User me\n")).toBe(true);
    const known = fs.readFileSync(path.join(home, ".ssh", "agentbox_known_hosts"), "utf8");
    expect(known).toBe(`agentbox-test ${HOST}\n`);
    expect(fs.statSync(path.join(home, ".ssh", "agentbox_known_hosts")).mode & 0o777).toBe(0o600);

    const again = await runCli(["ssh-setup"], { configDir: cfg, env: { HOME: home } });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toBe("Nothing to change: `ssh test` reaches the box.\n");
    expect(read(stub, "/home/coder/.ssh/authorized_keys")).toBe(`${KEY_B} someone-else\n${KEY_A} me@laptop\n`);
    expect(fs.readFileSync(path.join(home, ".ssh", "config"), "utf8")).toBe(config);
  });

  it("makes a key of its own when there is none", async () => {
    const { stub, cfg, home } = await setup();
    const r = await runCli(["ssh-setup"], { configDir: cfg, env: { HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/created the key ~\/.ssh\/agentbox_ed25519/);
    const pub = fs.readFileSync(path.join(home, ".ssh", "agentbox_ed25519.pub"), "utf8").trim();
    expect(read(stub, "/home/coder/.ssh/authorized_keys")).toContain(pub.split(" ").slice(0, 2).join(" "));
    expect(fs.statSync(path.join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  it("changes nothing here for a box without the SSH endpoint", async () => {
    const stub = await filesStub();
    stubs.push(stub);
    const home = tmpDir();
    const r = await runCli(["ssh-setup"], { configDir: signedIn(stub.url), env: { HOME: home } });
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/no SSH endpoint yet/);
    expect(fs.existsSync(path.join(home, ".ssh"))).toBe(false);
  });

  it("is undone by logout: the key off the box, the block and the pin gone here; --keep-ssh keeps them", async () => {
    const { stub, cfg, home } = await setup();
    fs.mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".ssh", "config"), "Host work\n  User me\n");
    fs.writeFileSync(path.join(home, ".ssh", "agentbox_known_hosts"), "agentbox-other ssh-ed25519 AAAA\n");
    expect((await runCli(["ssh-setup"], { configDir: cfg, env: { HOME: home } })).code).toBe(0);

    const kept = tmpDir();
    fs.cpSync(cfg, kept, { recursive: true });
    const k = await runCli(["logout", "--keep-ssh"], { configDir: kept, env: { HOME: home } });
    expect(k.code, k.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, ".ssh", "config"), "utf8")).toMatch(/Host test/);

    const r = await runCli(["logout"], { configDir: cfg, env: { HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/ssh: removed ~\/.ssh\/agentbox_ed25519.pub from ~\/.ssh\/authorized_keys on test/);
    expect(r.stderr).toMatch(/ssh: removed `Host test` from ~\/.ssh\/config/);
    expect(read(stub, "/home/coder/.ssh/authorized_keys")).toBe(`${KEY_B} someone-else\n`);
    expect(fs.readFileSync(path.join(home, ".ssh", "config"), "utf8")).toBe("Host work\n  User me\n");
    expect(fs.readFileSync(path.join(home, ".ssh", "agentbox_known_hosts"), "utf8")).toBe("agentbox-other ssh-ed25519 AAAA\n");
    expect(fs.existsSync(path.join(home, ".ssh", "agentbox_ed25519"))).toBe(true);
  });

  it("keeps --via across a new sign-in's setup, and --tunnel puts the tunnel back", async () => {
    const { cfg, home } = await setup();
    new ConfigStore(cfg).update((d) => {
      d.boxes.test!.sshVia = { host: "vps", project: "agentbox" };
    });
    let r = await runCli(["ssh-setup"], { configDir: cfg, env: { HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, ".ssh", "config"), "utf8")).toMatch(/ProxyCommand ssh (-F \S+ )?-T -o ClearAllForwardings=yes -- vps 'sh -c /);
    r = await runCli(["ssh-setup", "--tunnel"], { configDir: cfg, env: { HOME: home } });
    expect(r.stdout).toMatch(/reaching test through its HTTPS tunnel/);
    expect(fs.readFileSync(path.join(home, ".ssh", "config"), "utf8")).toMatch(/proxy tcp:2222 --box test/);
    expect(new ConfigStore(cfg).load().boxes.test?.sshVia).toBeUndefined();
  });
});
