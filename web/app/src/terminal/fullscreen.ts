import { rpc } from "../api/client.ts";

/**
 * Whether a pane is running a full-screen program, for the compose bar to step
 * aside. A terminal says so by switching to the alternate screen, but herdr
 * renders each pane server-side and sends the picture, not the program's mode
 * switches: the browser's xterm never leaves its normal screen. So the bar
 * also asks herdr what is in the foreground, and knows the usual full-screen
 * programs by name.
 */
export const FULL_SCREEN_PROGRAMS = new Set([
  "vi", "vim", "nvim", "view", "vimdiff", "nano", "pico", "micro", "emacs", "hx", "helix", "kak", "joe", "jed", "mcedit",
  "less", "more", "most", "man", "htop", "top", "btop", "atop", "nvtop", "glances", "iftop", "ncdu", "watch",
  "tmux", "screen", "zellij", "herdr", "mc", "ranger", "nnn", "lf", "vifm", "yazi", "lazygit", "lazydocker", "tig", "gitui",
  "k9s", "fzf", "w3m", "lynx", "mutt", "neomutt", "weechat", "irssi", "cmus",
]);

interface ProcessInfo {
  foreground_processes?: { name?: string; argv0?: string | null }[];
}

function base(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/** Whether herdr's process info shows a full-screen program in the foreground. */
export function isFullScreen(info: ProcessInfo | undefined): boolean {
  return (info?.foreground_processes ?? []).some(
    (p) => FULL_SCREEN_PROGRAMS.has(base(p.name ?? "")) || FULL_SCREEN_PROGRAMS.has(base(p.argv0 ?? "")),
  );
}

/** Ask herdr; on any failure, say no, so the bar is never lost to an error. */
export async function probeFullScreen(paneId: string): Promise<boolean> {
  try {
    const r = await rpc<{ process_info?: ProcessInfo }>("pane.process_info", { pane_id: paneId });
    return isFullScreen(r?.process_info);
  } catch {
    return false;
  }
}
