import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };

describe("the version the gate reports", () => {
  it("is the one the image was built with", () => {
    expect(loadConfig({ AGENTBOX_VERSION: "v1.4.0-3-gabc1234-dirty" }).version).toBe("v1.4.0-3-gabc1234-dirty");
  });

  it("falls back to the package's own when run from source", () => {
    expect(loadConfig({}).version).toBe(pkg.version);
    expect(loadConfig({ AGENTBOX_VERSION: "" }).version).toBe(pkg.version);
  });
});
