import { useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { ComposeField } from "./ComposeField.tsx";
import { loadHistory, pushHistory, useAltScreen } from "../terminal/modes.ts";
import { registerCompose, terminalHandle } from "../terminal/registry.ts";
import { probeFullScreen } from "../terminal/fullscreen.ts";

/** How often to ask herdr what runs in the pane (see terminal/fullscreen.ts). */
export const PROBE_MS = 1500;

const QUICK: { label: string; title: string; send: string | { arrow: "A" | "B" | "C" | "D" } }[] = [
  { label: "Esc", title: "Escape", send: "\x1b" },
  { label: "^C", title: "Ctrl+C — interrupt", send: "\x03" },
  { label: "^D", title: "Ctrl+D — end of input", send: "\x04" },
  { label: "Tab", title: "Tab", send: "\t" },
  { label: "←", title: "Left", send: { arrow: "D" } },
  { label: "↑", title: "Up", send: { arrow: "A" } },
  { label: "↓", title: "Down", send: { arrow: "B" } },
  { label: "→", title: "Right", send: { arrow: "C" } },
];

/**
 * A pane's compose bar: type a line locally, at local speed, and send it with
 * Enter as one write (the line, then Enter). Output keeps streaming above it,
 * and a click on the terminal still types there directly. The keys a terminal
 * needs that a text field would eat — Esc, Ctrl+C, Ctrl+D, Tab — go straight
 * through, as do the quick keys under it. When the program takes the whole
 * screen (an editor, a pager, htop) the bar steps aside and keys go direct;
 * it comes back when the program exits.
 */
export function PaneCompose({ paneId }: { paneId: string }) {
  const altScreen = useAltScreen((s) => s[paneId] === true);
  const [program, setProgram] = useState(false);
  const alt = altScreen || program;
  const [history, setHistory] = useState(() => loadHistory(paneId));
  const input = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  // The bar had the keyboard when a full-screen program took over: hand it back after.
  const stepped = useRef(false);

  const probe = useRef(() => {});
  useEffect(() => {
    let live = true;
    probe.current = () => {
      if (document.visibilityState === "visible") void probeFullScreen(paneId).then((on) => live && setProgram(on));
    };
    probe.current();
    const t = setInterval(() => probe.current(), PROBE_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [paneId]);

  useEffect(() => {
    if (alt) {
      if (focused.current) {
        stepped.current = true;
        terminalHandle(paneId)?.focus();
      }
      return;
    }
    if (stepped.current) {
      stepped.current = false;
      input.current?.focus();
    }
    return registerCompose(paneId, () => input.current?.focus());
  }, [alt, paneId]);

  if (alt) return null;

  const term = () => terminalHandle(paneId);

  return (
    <ComposeField
      className="pane-compose"
      label="Compose a line for the terminal"
      placeholder="Type a line, Enter to send…"
      history={history}
      sendEmpty
      inputRef={input}
      onFocusChange={(f) => (focused.current = f)}
      onSubmit={(text) => {
        term()?.submit(text);
        if (text.trim()) setHistory(pushHistory(paneId, text));
        // A command just started: if it takes the screen, step aside now rather than at the next poll.
        setTimeout(() => probe.current(), 300);
        return true;
      }}
      onKey={(e, { text, el, clear }) => {
        const bare = !e.altKey && !e.metaKey && !e.shiftKey;
        if (e.key === "Tab" && bare && !e.ctrlKey) {
          // Completion is the shell's: what is typed goes, then Tab.
          term()?.send(`${text}\t`);
          clear();
        } else if (e.key === "Escape" && bare && !e.ctrlKey) {
          term()?.send("\x1b");
        } else if (e.ctrlKey && bare && e.key.toLowerCase() === "c" && el.selectionStart === el.selectionEnd) {
          term()?.send("\x03"); // with text selected, Ctrl+C copies it as usual
        } else if (e.ctrlKey && bare && e.key.toLowerCase() === "d" && !text) {
          term()?.send("\x04");
        } else return false;
        e.preventDefault();
        return true;
      }}
    >
      <div className="compose-keys" role="toolbar" aria-label="Keys for the terminal">
        {QUICK.map((k) => (
          <button
            key={k.label}
            className="compose-key"
            title={k.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (typeof k.send === "string" ? term()?.send(k.send) : term()?.arrow(k.send.arrow))}
          >
            {k.label}
          </button>
        ))}
        <button
          className="compose-key compose-direct"
          title="Type straight into the terminal (click it, or this; click the bar to come back)"
          onClick={() => term()?.focus()}
        >
          <Keyboard size={13} aria-hidden="true" /> Raw keys
        </button>
      </div>
    </ComposeField>
  );
}
