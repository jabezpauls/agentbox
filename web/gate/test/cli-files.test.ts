import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTALL_PLACEHOLDER, renderInstallScript } from "../src/cli-files.js";
import { request, startHarness, type Harness } from "./helpers.js";

const TEMPLATE = `#!/bin/sh\nset -eu\nBOX='${INSTALL_PLACEHOLDER}'\nmain() { echo "$BOX"; }\nmain "$@"\n`;
const BUNDLE = "#!/usr/bin/env node\n// agentbox-cli 9.9.9-test\nconsole.log('hi');\n";

function cliDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-"));
  fs.writeFileSync(path.join(dir, "install"), TEMPLATE);
  fs.writeFileSync(path.join(dir, "agentbox.mjs"), BUNDLE);
  return dir;
}

describe("the install script's origin", () => {
  it("is written in only when it is a plain scheme://host[:port]", () => {
    for (const o of ["https://work.example.com", "http://127.0.0.1:7900", "http://localhost", "https://[::1]:8443"]) {
      expect(renderInstallScript(TEMPLATE, o), o).toContain(`BOX='${o}'`);
    }
    for (const o of ["https://x.example/'$(id)'", "https://x.example/path", "ftp://x.example", "https://x.example`id`", "https://a b", ""]) {
      expect(renderInstallScript(TEMPLATE, o), o).toBeNull();
    }
  });

  it("needs a template that asks for it", () => {
    expect(renderInstallScript("#!/bin/sh\n", "https://x.example")).toBeNull();
  });
});

describe("serving the CLI", () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = cliDir();
    h = await startHarness({ cliDir: dir });
  });
  afterAll(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves the install script to anyone, naming this box", async () => {
    const before = h.allSeen().length;
    const res = await request(h.base, "GET", "/cli/install");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toContain(`BOX='http://127.0.0.1:${h.port}'`);
    expect(res.body).not.toContain(INSTALL_PLACEHOLDER);
    expect(h.allSeen().length).toBe(before);
  });

  it("serves the bundle to anyone, byte for byte", async () => {
    const res = await request(h.base, "GET", "/cli/agentbox.mjs");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toBe(BUNDLE);
    const head = await request(h.base, "HEAD", "/cli/agentbox.mjs");
    expect(head.status).toBe(200);
  });

  it("never writes a Host header it cannot vouch for into the script", async () => {
    const res = await request(h.base, "GET", "/cli/install", { headers: { host: "evil.example'$(id)'" } });
    expect(res.status).toBe(200);
    expect(res.body).toContain("BOX='http://localhost'");
    expect(res.body).not.toContain("$(id)");
  });

  it("serves nothing else under /cli, and nothing reaches the sandbox without a session", async () => {
    const before = h.allSeen().length;
    for (const p of ["/cli/", "/cli/other", "/cli/install/x", "/cli/agentbox.mjs.map"]) {
      expect((await request(h.base, "GET", p)).status, p).toBe(401);
    }
    expect((await request(h.base, "POST", "/cli/install", { body: {}, headers: { origin: h.base } })).status).toBe(404);
    expect(h.allSeen().length).toBe(before);
  });
});

describe("serving the CLI behind a configured public URL", () => {
  it("names the public URL", async () => {
    const dir = cliDir();
    const h = await startHarness({ cliDir: dir, publicUrl: "https://work.example.com" });
    try {
      const res = await request(h.base, "GET", "/cli/install");
      expect(res.body).toContain("BOX='https://work.example.com'");
    } finally {
      await h.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write a public URL that is not a plain origin", async () => {
    const dir = cliDir();
    const h = await startHarness({ cliDir: dir, publicUrl: "https://work.example.com/sub'x" });
    try {
      const res = await request(h.base, "GET", "/cli/install");
      expect(res.status).toBe(500);
      expect(res.body).not.toContain("BOX=");
    } finally {
      await h.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
