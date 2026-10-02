import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ClipboardPaste, Copy } from "lucide-react";
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
import { TerminalSocket, terminalRtt, type ConnState, type ScrollState } from "./stream.ts";
import { thumb, WheelLines } from "./wheel.ts";
import { Predictor } from "./predict.ts";
import { PREDICT_MIN_RTT_MS, PredictionLayer, xtermScreen } from "./predictLayer.ts";
import { paneMode, useAltScreen, useTermModes } from "./modes.ts";
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
  const [scroll, setScroll] = useState<ScrollState | null>(null);

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

    // Predictive echo: guesses painted over the screen until the echo lands.
    const predictor = new Predictor(xtermScreen(term), { timeoutMs: () => Math.max(1000, 3 * (terminalRtt() ?? 0)) });
    const layer = new PredictionLayer(term);
    let tickTimer: ReturnType<typeof setTimeout> | null = null;
    const redraw = () => layer.render(predictor.overlay());
    const predicting = () => paneMode(useTermModes.getState(), paneId, "predict") && (terminalRtt() ?? 0) > PREDICT_MIN_RTT_MS;
    const guess = (d: string) => {
      if (!predicting()) {
        if (predictor.pending) predictor.reset();
      } else {
        predictor.input(d);
        if (tickTimer) clearTimeout(tickTimer);
        tickTimer = setTimeout(() => {
          predictor.tick();
          redraw();
        }, 1000 + 3 * (terminalRtt() ?? 0) + 20);
      }
      redraw();
    };
    const forget = () => {
      predictor.reset();
      redraw();
    };
    const unsubModes = useTermModes.subscribe(() => {
      if (!paneMode(useTermModes.getState(), paneId, "predict")) forget();
    });
    const altSub = term.buffer.onBufferChange((b) => {
      useAltScreen.setState({ [paneId]: b.type === "alternate" });
      forget();
    });

    const unregister = registerTerminal(paneId, {
      focus: () => term.focus(),
      send: (data) => {
        // Not through xterm's onData: no guess is made for what the bar sends.
        forget();
        socketRef.current?.input(data);
      },
      submit: (text) => {
        forget();
        // Several lines go as one paste when the program asked for bracketed
        // paste, so a shell does not run them one by one; then Enter.
        const body = text.replace(/\r?\n/g, "\r");
        const multi = body.includes("\r");
        const wrapped = multi && term.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body;
        socketRef.current?.input(`${wrapped}\r`);
      },
      arrow: (dir) => {
        forget();
        socketRef.current?.input(`${term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b["}${dir}`);
      },
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
    // The wheel goes to herdr, which knows what the program in the pane wants
    // of it (see wheel.ts). xterm's own handling would turn it into arrow keys,
    // since this terminal keeps no scrollback, and send those as typing.
    const wheel = new WheelLines();
    term.attachCustomWheelEventHandler((e) => {
      e.preventDefault();
      const screen = term.element?.querySelector(".xterm-screen");
      const rowHeight = screen ? screen.clientHeight / term.rows : 16;
      const act = wheel.take(e, rowHeight, term.rows);
      if (act) socket?.scroll(act.direction, act.lines);
      return false;
    });
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
      socket.onData((bytes) =>
        term.write(bytes, () => {
          if (!predictor.pending) return;
          predictor.update();
          redraw();
        }),
      );
      socket.onState(setConn);
      socket.onGone(setGone);
      socket.onScroll(setScroll);
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
        if (r.passthrough) {
          forget();
          socket?.input(r.passthrough);
        }
        if (r.action) runAction(r.action, actionCtx());
        return false;
      });
      term.onData((d) => {
        // Real input and pastes go out first and untouched; the guess is only paint.
        socket?.input(d);
        guess(d);
      });

      term.textarea?.addEventListener("focus", onFocus);
      host.addEventListener("mouseup", onMouseUp);
      host.addEventListener("contextmenu", onContextMenu);

      ro = new ResizeObserver(() => {
        const was = `${term.cols}x${term.rows}`;
        try {
          fit.fit();
        } catch {
          return;
        }
        socket?.resize(term.cols, term.rows);
        if (`${term.cols}x${term.rows}` !== was) forget();
      });
      ro.observe(host);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unregister();
      if (tickTimer) clearTimeout(tickTimer);
      unsubModes();
      altSub.dispose();
      layer.dispose();
      useAltScreen.setState({ [paneId]: false });
      ro?.disconnect();
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
  const bar = scroll ? thumb(scroll.offset, scroll.max, scroll.rows) : null;
  const back = scroll !== null && scroll.offset > 0;
  const mac = isMacPlatform();

  return (
    <div className="term-host" ref={hostRef}>
      {bar && (
        <div className={`term-scrollbar${back ? " is-back" : ""}`} aria-hidden="true">
          <div className="term-scrollbar-thumb" style={{ top: `${bar.top * 100}%`, height: `${bar.height * 100}%` }} />
        </div>
      )}
      {back && (
        <button
          className="term-live btn btn-small"
          title="Back to the live screen (or just type)"
          onClick={() => {
            socketRef.current?.scrollTo(0);
            termRef.current?.focus();
          }}
        >
          <ArrowDownToLine size={14} aria-hidden="true" />
          Jump to live
          <span className="term-live-count">{scroll.offset} lines up</span>
        </button>
      )}
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
