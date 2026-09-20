import os from "node:os"; import path from "node:path";
export interface Config {
  port: number; basePath: string; staticDir: string | null; socketPath: string;
  workspaceRoot: string; previewDomain: string | null; lavishUrl: string | null; lavishStateDir: string; lavishPort: number;
}
export function defaultSocketPath(env = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const cfg = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(cfg, "herdr", "herdr.sock");
}
export function loadConfig(env = process.env): Config {
  const base = (env.WORKBENCH_BASE_PATH ?? "/workbench").replace(/\/+$/, "") || "";
  return {
    port: Number(env.WORKBENCH_PORT ?? 7800), basePath: base,
    staticDir: env.WORKBENCH_STATIC_DIR ?? null, socketPath: defaultSocketPath(env),
    workspaceRoot: env.WORKBENCH_WORKSPACE_ROOT ?? "/workspace",
    previewDomain: env.WORKBENCH_PREVIEW_DOMAIN || null, lavishUrl: (env.WORKBENCH_LAVISH_URL || null)?.replace(/\/+$/, "") ?? null,
    lavishStateDir: env.LAVISH_AXI_STATE_DIR ?? path.join(env.HOME || os.homedir(), ".lavish-axi"),
    lavishPort: Number(env.LAVISH_AXI_PORT ?? 4387),
  };
}
