import os from "node:os"; import path from "node:path";
export interface Config {
  port: number; staticDir: string | null; socketPath: string;
  workspaceRoot: string; previewDomain: string | null; reviewDir: string; publicUrl: string | null;
  /**
   * The files API's second root, hidden in the app by default. A separate
   * volume from the workspace, which is why the trash and upload scratch space
   * are kept per root rather than in one place.
   */
  homeRoot: string;
  /** Where minted public share records live; on the home volume, like reviews. */
  sharesDir: string;
  /** True when previews may be shared publicly under `/s/<token>/`. */
  previewSharing: boolean;
  /**
   * agentbox's own listeners inside the shared namespace: the bridge, the
   * editor and the three ttyd services. Flagged as system ports in the panel,
   * and never shareable — a public link must not reach a shell.
   */
  infraPorts: number[];
}
export function defaultSocketPath(env = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const cfg = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(cfg, "herdr", "herdr.sock");
}
export function loadConfig(env = process.env): Config {
  const port = Number(env.WORKBENCH_PORT ?? 7800);
  return {
    port,
    infraPorts: [port, 8080, 7681, 7682, 7683].filter((p) => p > 0),
    staticDir: env.WORKBENCH_STATIC_DIR ?? null, socketPath: defaultSocketPath(env),
    workspaceRoot: env.WORKBENCH_WORKSPACE_ROOT ?? "/workspace",
    homeRoot: env.WORKBENCH_HOME_ROOT ?? (env.HOME || os.homedir()),
    previewDomain: env.WORKBENCH_PREVIEW_DOMAIN || null,
    // Review sessions live on the home volume so they survive restarts and
    // updates, which is what lets an agent block on a poll across a redeploy.
    reviewDir: env.WORKBENCH_REVIEW_DIR ?? path.join(env.HOME || os.homedir(), ".agentbox", "review"),
    // The origin a person browses to. Only used to print a clickable link from
    // the CLI; unset, the bridge falls back to the requesting Host.
    publicUrl: (env.WORKBENCH_PUBLIC_URL || null)?.replace(/\/+$/, "") ?? null,
    // Share records persist on the home volume so a minted link survives a
    // restart, exactly like review sessions.
    sharesDir: env.WORKBENCH_SHARES_DIR ?? path.join(env.HOME || os.homedir(), ".agentbox", "shares"),
    // `path` (the default) allows public sharing; `off` refuses to mint or
    // serve shares. Set by the installer's `--preview` flag.
    previewSharing: (env.WORKBENCH_PREVIEW_MODE ?? "path") !== "off",
  };
}
