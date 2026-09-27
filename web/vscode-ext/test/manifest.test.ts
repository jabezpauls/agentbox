import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  contributes: { configuration: { properties: Record<string, { scope?: string }> } };
  capabilities: { untrustedWorkspaces: { supported: boolean } };
};

describe("the extension's manifest", () => {
  it("lets only the machine, never a workspace, say where the bridge is", () => {
    // A folder's .vscode/settings.json is written by whoever made the folder;
    // it must not be able to point the editor at another server.
    expect(manifest.contributes.configuration.properties["agentbox.bridgeUrl"]?.scope).toBe("machine");
  });

  it("runs in folders that are not trusted, since it runs nothing from them", () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(true);
  });
});
