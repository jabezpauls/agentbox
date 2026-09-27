import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { SessionHub } from "../../src/herdr/session.js";
import { FilesService, type FilesOptions } from "../../src/files/service.js";

export const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({ panes: [], workspaces: [], tabs: [], agents: [], layouts: [] }),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

export function tmpBase(): string {
  return fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
}

export interface FilesFixture {
  base: string;
  workspace: string;
  home: string;
  files: FilesService;
  app: FastifyInstance;
  close(): Promise<void>;
}

/**
 * A bridge serving the files API over two throwaway roots. Nothing here ever
 * points at the developer's own home or at /workspace.
 */
export async function filesFixture(opts: Partial<FilesOptions> = {}): Promise<FilesFixture> {
  const base = fs.mkdtempSync(path.join(tmpBase(), "wb-files-"));
  const workspace = path.join(base, "workspace");
  const home = path.join(base, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const files = new FilesService({ workspaceRoot: workspace, homeRoot: home, gitTtlMs: 0, ...opts });
  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: path.join(base, "no-herdr.sock"),
    WORKBENCH_STATIC_DIR: path.join(base, "no-static"),
    WORKBENCH_WORKSPACE_ROOT: workspace,
    WORKBENCH_HOME_ROOT: home,
    WORKBENCH_REVIEW_DIR: path.join(base, "review"),
    WORKBENCH_SHARES_DIR: path.join(base, "shares"),
    HOME: home,
  });
  const app = await buildApp(config, { hub: stubHub, files });
  await app.ready();
  return {
    base,
    workspace,
    home,
    files,
    app,
    close: async () => {
      await app.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** A path made of raw bytes under `dir`: for names that are not UTF-8. */
export function rawPath(dir: string, bytes: number[]): Buffer {
  return Buffer.concat([Buffer.from(dir + "/"), Buffer.from(bytes)]);
}

/** Percent-encode every byte of a Buffer, for a query string. */
export function pct(buf: Buffer): string {
  return [...buf].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
}
