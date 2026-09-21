import { useEffect, useRef } from "react";
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
import { rpc } from "../api/client.ts";
import { comboFromEvent } from "../keys/combo.ts";
import { PrefixMachine } from "../keys/prefix.ts";
import { DEFAULT_BINDINGS, runAction } from "../keys/actions.ts";
import { TerminalSocket } from "./stream.ts";
import { terminalTheme } from "./themes.ts";

// One prefix machine for the whole app: arming is global, so a prefix pressed
// in one pane and its follow-up (even after focus moves) resolve together, and
// the HUD reflects a single armed state.
const machine = new PrefixMachine("ctrl+b", DEFAULT_BINDINGS);
let hudTimer: ReturnType<typeof setTimeout> | null = null;

function reflectHud(): void {
  const { ui, setUi } = useApp.getState();
  if (ui.prefixArmed !== machine.armed) setUi({ prefixArmed: machine.armed });
  if (hudTimer) clearTimeout(hudTimer);
  if (machine.armed) {
    // Clear the pill if the armed prefix simply times out with no follow-up.
    hudTimer = setTimeout(() => {
      if (!machine.armed && useApp.getState().ui.prefixArmed) useApp.getState().setUi({ prefixArmed: false });
    }, 3100);
  }
}

interface Props {
  paneId: string;
  resolved: Resolved;
}

export function TerminalCell({ paneId, resolved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  // Keep the latest resolved theme reachable from the mount-once effect.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

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
      theme: terminalTheme(resolvedRef.current),
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
      socket.onClose((reason) => term.write(`\r\n\x1b[2m[${reason}]\x1b[0m\r\n`));

      // Keystrokes: run the prefix layer first; anything it consumes is
      // swallowed from xterm (return false), so the terminal only sees input.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
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
        if (r.action) runAction(r.action, { store: useApp, rpc });
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

  // Re-theme live terminals when the app theme switches.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(resolved);
  }, [resolved]);

  return <div className="term-host" ref={hostRef} />;
}

/** localhost links open the inspector's preview; everything else opens a tab. */
function openLink(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    useApp.getState().setInspector({
      open: true,
      tab: "preview",
      port,
      path: url.pathname + url.search + url.hash,
    });
  } else {
    window.open(uri, "_blank", "noopener,noreferrer");
  }
}
