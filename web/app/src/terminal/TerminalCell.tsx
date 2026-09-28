import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import type { Resolved } from "../theme/useTheme.ts";
import { useApp } from "../store/app.ts";
import { actionCtx } from "../api/call.ts";
import { comboFromEvent } from "../keys/combo.ts";
import { runAction } from "../keys/actions.ts";
import { machine, reflectHud } from "../keys/machine.ts";
import { TerminalSocket, type ConnState } from "./stream.ts";
import { terminalTheme } from "./themes.ts";
import { registerTerminal } from "./registry.ts";
import { handleChord } from "../shell/actions.ts";
import { isPaletteKey } from "../shell/keys.ts";

interface Props {
  paneId: string;
  resolved: Resolved;
}

const NOTICE: Partial<Record<ConnState, string>> = {
  reconnecting: "Reconnecting…",
  lost: "Disconnected",
};

export function TerminalCell({ paneId, resolved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [gone, setGone] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      scrollback: 0,
      allowProposedApi: true,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: terminalTheme(),
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_ev, uri) => openLink(uri)));
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable (headless, blocklisted GPU): xterm's DOM renderer
      // stays in place, which is correct, just slower.
    }

    const unregister = registerTerminal(paneId, {
      focus: () => term.focus(),
      text: () => {
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        return lines.join("\n");
      },
    });

    let disposed = false;
    let socket: TerminalSocket | null = null;
    let ro: ResizeObserver | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      socket?.scroll(e.deltaY > 0 ? "down" : "up", 3);
    };
    const onMouseUp = () => {
      // Copy on mouse-up when a selection exists, like the TUI.
      if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
    };
    const onFocus = () => {
      // Focus: tell herdr and claim the pane's size for this viewer.
      socket?.focus();
      if (useApp.getState().session.focusedPaneId !== paneId) useApp.getState().focusPane(paneId);
    };

    // Defer the first fit and the socket to the next frame: by then xterm's
    // renderer has measured the cell size, so fitting cannot read undefined
    // dimensions, and a StrictMode remount that tears down first never opens a
    // socket at all.
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // Host has no layout yet; the ResizeObserver will fit once it does.
      }
      socket = new TerminalSocket(paneId, { cols: term.cols, rows: term.rows });
      socketRef.current = socket;
      socket.onData((bytes) => term.write(bytes));
      socket.onState(setConn);
      socket.onGone(setGone);
      // Another viewer resized or focused this pane: herdr's geometry is
      // authoritative for everyone attached, so follow it.
      socket.onSize(({ cols, rows }) => {
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      });

      // Keystrokes: run the prefix layer first; anything it consumes is
      // swallowed from xterm (return false), so the terminal only sees input.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        // The app's ⌃⌥ chords — another surface, the palette, the dock — work
        // from inside a terminal too; no terminal program uses them.
        if (handleChord(e)) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        // ⌘K opens the command palette even while a terminal is focused;
        // Ctrl+K is the shell's own (kill-line) and goes through.
        if (isPaletteKey(e, true)) {
          e.preventDefault();
          useApp.getState().setUi({ palette: { mode: "all" } });
          return false;
        }
        const r = machine.feed(comboFromEvent(e));
        reflectHud();
        if (!r.consumed) return true;
        // xterm bails out *without* preventing the default when a custom
        // handler returns false, so the character would still be inserted into
        // the helper textarea and sent as input. Prevent it ourselves so the
        // prefix layer truly swallows the key.
        e.preventDefault();
        e.stopPropagation();
        if (r.passthrough) socket?.input(r.passthrough);
        if (r.action) runAction(r.action, actionCtx());
        return false;
      });
      term.onData((d) => socket?.input(d)); // real input and pastes

      term.textarea?.addEventListener("focus", onFocus);
      host.addEventListener("wheel", onWheel, { passive: false });
      host.addEventListener("mouseup", onMouseUp);

      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        socket?.resize(term.cols, term.rows);
      });
      ro.observe(host);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unregister();
      ro?.disconnect();
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("mouseup", onMouseUp);
      term.textarea?.removeEventListener("focus", onFocus);
      socket?.close();
      term.dispose();
      termRef.current = null;
      socketRef.current = null;
    };
    // Mount once per pane; theme changes are handled by the effect below.
  }, [paneId]);

  // Re-theme live terminals when the app theme switches. `resolved` is the
  // trigger; the colours themselves come from the tokens now on :root.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme();
  }, [resolved]);

  const notice = gone ?? NOTICE[conn] ?? null;

  return (
    <div className="term-host" ref={hostRef}>
      {notice && (
        <div className="term-notice" role="status">
          <span className="term-notice-text">{notice}</span>
          {conn === "lost" && !gone && (
            <button className="btn btn-small" onClick={() => socketRef.current?.retry()}>
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** localhost links open that server as an app in Preview; everything else opens a tab. */
function openLink(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    void useApp.getState().openPort(port, url.pathname + url.search + url.hash);
  } else {
    window.open(uri, "_blank", "noopener,noreferrer");
  }
}
