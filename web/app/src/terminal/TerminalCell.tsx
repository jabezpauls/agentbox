import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Copy } from "lucide-react";
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
import { isMacPlatform, isPaletteKey } from "../shell/keys.ts";
import { Menu } from "../components/ui/Menu.tsx";
import { clipboardKey, parseOsc52, useCopyOnSelect, writeClipboard } from "./clipboard.ts";

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
  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null);

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
      // Shift+drag selects text even while the program in the pane has the
      // mouse (Claude Code, herdr); on a Mac that key is Option.
      macOptionClickForcesSelection: true,
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

    // OSC 52: a program in the box copies to this viewer's clipboard. A
    // request to read the clipboard back is swallowed, never answered.
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const r = parseOsc52(data);
      if (r && r !== "read") writeClipboard(r.write);
      return true;
    });

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
      // Copy on mouse-up when a selection exists, like the TUI — unless
      // Settings turned that off.
      if (useCopyOnSelect.getState().on && term.hasSelection()) writeClipboard(term.getSelection());
    };
    const onContextMenu = (e: MouseEvent) => {
      // A program that asked for the mouse gets its right-clicks; Shift still
      // opens the menu over it.
      if (term.modes.mouseTrackingMode !== "none" && !e.shiftKey) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, selection: term.hasSelection() });
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
        // Copy and paste: Ctrl+Shift+C / Ctrl+Shift+V, and ⌘C / ⌘V on a Mac.
        const clip = clipboardKey(e, isMacPlatform(), term.hasSelection());
        if (clip === "copy") {
          e.preventDefault();
          writeClipboard(term.getSelection());
          return false;
        }
        if (clip === "paste") {
          // ⌘V is the browser's own paste, which xterm takes from there; the
          // Ctrl+Shift form is not, so read the clipboard for it.
          if (!e.metaKey) {
            e.preventDefault();
            pasteFromClipboard(term);
          }
          return false;
        }
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
      host.addEventListener("contextmenu", onContextMenu);

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
      host.removeEventListener("contextmenu", onContextMenu);
      osc52.dispose();
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
  const mac = isMacPlatform();

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
      {menu && (
        <Menu
          anchor={{ x: menu.x, y: menu.y }}
          label="Terminal"
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Copy",
              icon: Copy,
              keys: mac ? "⌘C" : "Ctrl+Shift+C",
              disabled: !menu.selection,
              onSelect: () => termRef.current && writeClipboard(termRef.current.getSelection()),
            },
            {
              label: "Paste",
              icon: ClipboardPaste,
              keys: mac ? "⌘V" : "Ctrl+Shift+V",
              onSelect: () => termRef.current && pasteFromClipboard(termRef.current),
            },
          ]}
        />
      )}
    </div>
  );
}

/** Paste the clipboard's text into the terminal as a paste (bracketed, if the program asked). */
function pasteFromClipboard(term: Terminal): void {
  navigator.clipboard
    ?.readText()
    .then((text) => {
      if (text) term.paste(text);
    })
    .catch(() => {});
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
