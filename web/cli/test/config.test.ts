import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, configDir, defaultBoxName, isLoopbackHost, normalizeBoxUrl, publicView } from "../src/config.js";
import { CliError, EXIT, UsageError } from "../src/errors.js";
import { TOKEN, runCli, tmpDir } from "./helpers.js";

const posix = process.platform !== "win32";
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe("where the configuration lives", () => {
  it("follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u")).toBe(path.join("/x/cfg", "agentbox"));
    expect(configDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "agentbox"));
    // A relative XDG_CONFIG_HOME is invalid by the spec, and ignored.
    expect(configDir({ XDG_CONFIG_HOME: "rel" }, "/home/u")).toBe(path.join("/home/u", ".config", "agentbox"));
  });
});

describe("the configuration file", () => {
  it("starts empty, and is written private: the file 0600, its folder 0700", () => {
    const dir = path.join(tmpDir(), "agentbox");
    const store = new ConfigStore(dir);
    expect(store.load()).toEqual({ version: 1, current: null, boxes: {} });
    store.update((d) => {
      d.boxes.work = { url: "https://work.example.com", token: TOKEN, addedAt: 1 };
      d.current = "work";
    });
    expect(store.load().boxes.work?.token).toBe(TOKEN);
    if (posix) {
      expect(mode(store.file)).toBe(0o600);
      expect(mode(dir)).toBe(0o700);
    }
    // No temporary file left behind.
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it.runIf(posix)("stays private under a lax umask, and a strict one", () => {
    for (const mask of [0o000, 0o077, 0o222]) {
      const parent = tmpDir();
      const old = process.umask(mask);
      try {
        const store = new ConfigStore(path.join(parent, "agentbox"));
        store.update((d) => {
          d.current = null;
        });
        expect(mode(store.file), `umask ${mask.toString(8)}`).toBe(0o600);
      } finally {
        process.umask(old);
      }
    }
  });

  it.runIf(posix)("closes a file others can read, and says so", () => {
    const dir = path.join(tmpDir(), "agentbox");
    const warnings: string[] = [];
    const store = new ConfigStore(dir, { warn: (m) => warnings.push(m) });
    store.update((d) => {
      d.boxes.a = { url: "https://a.example", token: TOKEN, addedAt: 1 };
    });
    fs.chmodSync(store.file, 0o644);
    fs.chmodSync(dir, 0o755);
    store.load();
    expect(mode(store.file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(warnings.join()).toMatch(/readable by other users/);
    // Once is enough.
    store.load();
    expect(warnings).toHaveLength(1);
  });

  it("changes what is on disk now, not what was read earlier", () => {
    const dir = path.join(tmpDir(), "agentbox");
    const a = new ConfigStore(dir);
    const b = new ConfigStore(dir);
    a.update((d) => {
      d.boxes.one = { url: "https://one.example", token: TOKEN, addedAt: 1 };
    });
    // Another process (a login in another terminal) adds a box...
    b.update((d) => {
      d.boxes.two = { url: "https://two.example", token: TOKEN, addedAt: 2 };
    });
    // ...and a long-running one saving its own change keeps it.
    a.update((d) => {
      d.current = "one";
    });
    expect(Object.keys(a.load().boxes).sort()).toEqual(["one", "two"]);
  });

  it("refuses a file that is not its own, rather than overwriting it", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "config.json"), "{not json");
    expect(() => new ConfigStore(dir).load()).toThrow(/not valid JSON/);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 7 }));
    expect(() => new ConfigStore(dir).load()).toThrow(/not an agentbox configuration/);
  });

  it("drops a current box that no longer exists", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, current: "gone", boxes: {} }));
    expect(new ConfigStore(dir).load().current).toBeNull();
  });

  it("names the box to use, or says why there is none", () => {
    const store = new ConfigStore(tmpDir());
    const err = (): CliError => {
      try {
        store.resolve();
      } catch (e) {
        return e as CliError;
      }
      throw new Error("resolved");
    };
    expect(err().message).toMatch(/agentbox login/);
    expect(err().exitCode).toBe(EXIT.AUTH);
    store.update((d) => {
      d.boxes.a = { url: "https://a.example", token: TOKEN, addedAt: 1 };
    });
    expect(err().message).toMatch(/agentbox use/);
    expect(store.resolve("a").box.url).toBe("https://a.example");
    expect(() => store.resolve("b")).toThrow(/no box named "b"/);
  });
});

describe("box addresses and names", () => {
  it("normalises what people type", () => {
    expect(normalizeBoxUrl("work.example.com")).toBe("https://work.example.com");
    expect(normalizeBoxUrl(" https://work.example.com/login?next=/ ")).toBe("https://work.example.com");
    expect(normalizeBoxUrl("http://127.0.0.1:7900/")).toBe("http://127.0.0.1:7900");
    expect(normalizeBoxUrl("HTTPS://Work.Example.com:443")).toBe("https://work.example.com");
    expect(() => normalizeBoxUrl("ftp://x.example")).toThrow(UsageError);
    expect(() => normalizeBoxUrl("https://user:pw@x.example")).toThrow(/leave the user name and password out/);
    expect(() => normalizeBoxUrl("")).toThrow(UsageError);
  });

  it("knows loopback", () => {
    for (const h of ["localhost", "127.0.0.1", "127.8.9.1", "[::1]", "app.localhost"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["example.com", "10.0.0.1", "localhost.example.com"]) expect(isLoopbackHost(h), h).toBe(false);
  });

  it("picks a short name from the address", () => {
    expect(defaultBoxName("https://work.example.com")).toBe("work");
    expect(defaultBoxName("http://localhost:7900")).toBe("localhost-7900");
    expect(defaultBoxName("http://127.0.0.1:7900")).toBe("127.0.0.1-7900");
    expect(defaultBoxName("https://[::1]:8443")).toBe("1-8443");
  });

  it("shows a box without its token", () => {
    const view = publicView("work", { url: "https://w.example", token: TOKEN, addedAt: 1, tokenId: "t1" }, true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view).toMatchObject({ name: "work", url: "https://w.example", current: true, tokenId: "t1" });
  });
});

describe("boxes and use", () => {
  it("lists boxes without their tokens, and switches between them", async () => {
    const dir = tmpDir();
    const store = new ConfigStore(dir);
    store.update((d) => {
      d.boxes.work = { url: "https://work.example.com", token: TOKEN, addedAt: 1, user: "jabe" };
      d.boxes.home = { url: "https://home.example.com", token: TOKEN, addedAt: 2 };
      d.current = "work";
    });
    const human = await runCli(["boxes"], { configDir: dir });
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/\*\s+work\s+https:\/\/work\.example\.com\s+jabe/);
    const asJson = await runCli(["boxes", "--json"], { configDir: dir });
    expect(JSON.parse(asJson.stdout)).toHaveLength(2);
    for (const out of [human.stdout, asJson.stdout, human.stderr, asJson.stderr]) expect(out).not.toContain(TOKEN);

    expect((await runCli(["use", "home"], { configDir: dir })).code).toBe(0);
    expect(store.load().current).toBe("home");
    const missing = await runCli(["use", "nope"], { configDir: dir });
    expect(missing.code).toBe(EXIT.NOT_FOUND);
    expect(store.load().current).toBe("home");
  });
});
