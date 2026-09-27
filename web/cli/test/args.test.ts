import { describe, expect, it } from "vitest";
import { int, parseArgs, parseSize, type CommandShape } from "../src/args.js";
import { COMMANDS } from "../src/commands/index.js";
import { UsageError } from "../src/errors.js";

const CMDS: CommandShape[] = [
  { path: ["login"], options: [{ name: "name", type: "string", description: "" }, { name: "no-browser", type: "boolean", description: "" }], operands: { min: 1, max: 1 } },
  { path: ["status"], options: [], operands: { min: 0, max: 0 } },
  {
    path: ["files", "put"],
    options: [
      { name: "recursive", short: "r", type: "boolean", description: "" },
      { name: "force", short: "f", type: "boolean", description: "" },
      { name: "chunk-size", short: "c", type: "string", description: "" },
    ],
    operands: { min: 1, max: Infinity },
  },
  { path: ["files", "ls"], options: [{ name: "all", short: "a", type: "boolean", description: "" }], operands: { min: 0, max: 1 } },
];

describe("parseArgs", () => {
  it("finds a command and its operand", () => {
    const p = parseArgs(["login", "https://box.example"], CMDS);
    expect(p.command?.path).toEqual(["login"]);
    expect(p.operands).toEqual(["https://box.example"]);
  });

  it("takes the global options before or after the command", () => {
    const a = parseArgs(["--box", "work", "--json", "status"], CMDS);
    const b = parseArgs(["status", "--json", "--box=work"], CMDS);
    for (const p of [a, b]) {
      expect(p.command?.path).toEqual(["status"]);
      expect(p.globals).toMatchObject({ box: "work", json: true, help: false });
    }
  });

  it("reads two-word commands, combined short flags and values", () => {
    const p = parseArgs(["files", "put", "-rf", "-c", "1M", "a", "b", "/dest"], CMDS);
    expect(p.command?.path).toEqual(["files", "put"]);
    expect(p.options).toEqual({ recursive: true, force: true, "chunk-size": "1M" });
    expect(p.operands).toEqual(["a", "b", "/dest"]);
    expect(parseArgs(["files", "put", "-c64K", "a"], CMDS).options["chunk-size"]).toBe("64K");
    expect(parseArgs(["files", "put", "--chunk-size=2M", "a"], CMDS).options["chunk-size"]).toBe("2M");
  });

  it("treats everything after -- as operands, and - as one", () => {
    const p = parseArgs(["files", "put", "--", "-r", "--force", "-"], CMDS);
    expect(p.options).toEqual({});
    expect(p.operands).toEqual(["-r", "--force", "-"]);
  });

  it("does not take an operand that happens to be a command word for part of the name", () => {
    const p = parseArgs(["files", "ls", "put"], CMDS);
    expect(p.command?.path).toEqual(["files", "ls"]);
    expect(p.operands).toEqual(["put"]);
  });

  it("refuses what it cannot place", () => {
    expect(() => parseArgs(["status", "--nope"], CMDS)).toThrow(/unknown option --nope for `agentbox status`/);
    expect(() => parseArgs(["files", "ls", "-z"], CMDS)).toThrow(/unknown option -z/);
    expect(() => parseArgs(["login", "--name"], CMDS)).toThrow(/--name needs a value/);
    expect(() => parseArgs(["login", "--no-browser=1", "x"], CMDS)).toThrow(/takes no value/);
    expect(() => parseArgs(["login"], CMDS)).toThrow(UsageError);
    expect(() => parseArgs(["login", "a", "b"], CMDS)).toThrow(/too many arguments/);
    expect(() => parseArgs(["status", "extra"], CMDS)).toThrow(/too many arguments/);
  });

  it("does not count operands when help was asked for", () => {
    const p = parseArgs(["files", "put", "--help"], CMDS);
    expect(p.command?.path).toEqual(["files", "put"]);
    expect(p.globals.help).toBe(true);
  });

  it("leaves unknown words for the caller to name", () => {
    expect(parseArgs(["frobnicate", "--json"], CMDS)).toMatchObject({ command: null, words: ["frobnicate"] });
    expect(parseArgs(["files"], CMDS)).toMatchObject({ command: null, words: ["files"] });
    expect(parseArgs(["files", "nope"], CMDS)).toMatchObject({ command: null, words: ["files", "nope"] });
    expect(parseArgs([], CMDS)).toMatchObject({ command: null, words: [] });
  });

  it("parses every real command's own --help", () => {
    for (const c of COMMANDS) {
      const p = parseArgs([...c.path, "--help"], COMMANDS);
      expect(p.command, c.path.join(" ")).toBe(c);
    }
  });

  it("never lets two options of one command share a name or a letter", () => {
    for (const c of COMMANDS) {
      const all = [...c.options.map((o) => o.name), "box", "json", "help", "version"];
      expect(new Set(all).size, c.path.join(" ")).toBe(all.length);
      const shorts = [...c.options.flatMap((o) => (o.short ? [o.short] : [])), "h", "V"];
      expect(new Set(shorts).size, c.path.join(" ")).toBe(shorts.length);
    }
  });
});

describe("option values", () => {
  it("reads sizes as people write them", () => {
    expect(parseSize("1048576")).toBe(1048576);
    expect(parseSize("64K")).toBe(65536);
    expect(parseSize("8m")).toBe(8 * 1024 * 1024);
    expect(parseSize("2MiB")).toBe(2 * 1024 * 1024);
    expect(parseSize("1.5M")).toBe(1572864);
    expect(() => parseSize("lots")).toThrow(UsageError);
  });

  it("bounds whole numbers", () => {
    expect(int({ port: "8080" }, "port", 1, 65535)).toBe(8080);
    expect(int({}, "port", 1, 65535)).toBeUndefined();
    expect(() => int({ port: "0" }, "port", 1, 65535)).toThrow(/from 1 to 65535/);
    expect(() => int({ port: "x" }, "port", 1, 65535)).toThrow(UsageError);
  });
});
