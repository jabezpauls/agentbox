import { spawn } from "node:child_process";

/**
 * Open a URL in the person's browser, when there is one to open it in. Every
 * helper is run without a shell, with the URL as one argument, so nothing in
 * it is ever interpreted: `rundll32` rather than `cmd /c start` on Windows for
 * the same reason.
 */

export interface Launcher {
  command: string;
  args: string[];
}

export function browserLauncher(url: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Launcher | null {
  if (env.BROWSER) return { command: env.BROWSER, args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  // Over ssh, or on a server, there is nothing to open it in.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { command: "xdg-open", args: [url] };
}

/** True when a browser was launched (not that it showed the page). */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const launcher = browserLauncher(url, platform, env);
  if (!launcher) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(launcher.command, launcher.args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
