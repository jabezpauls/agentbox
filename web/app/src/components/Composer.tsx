import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useApp } from "../store/app.ts";
import { call } from "../api/call.ts";
import { paneTitle } from "../store/session.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { focusTerminal } from "../terminal/registry.ts";

/**
 * Whether a key event is part of an in-flight IME composition. A CJK
 * composition commit arrives as an Enter with `isComposing` set (and, in some
 * browsers, only as `keyCode === 229`), and both flags can live on either the
 * synthetic event or the native one. Send on such an Enter and the user's
 * half-finished word goes to the agent instead of being committed.
 */
function isComposing(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
  return Boolean(e.nativeEvent.isComposing || native.isComposing) || e.keyCode === 229 || native.keyCode === 229;
}

/**
 * A single-line (growing to four) composer shown under the grid when the
 * focused pane hosts an agent. Enter sends, Shift+Enter starts a new line, and
 * ⌘/Ctrl+Enter sends as well for the muscle memory that predates it. herdr
 * refuses prompts to blocked agents, so the field disables itself and says why.
 * Escape returns focus to the terminal.
 */
export function Composer() {
  const focusedPaneId = useApp((s) => s.session.focusedPaneId);
  const agent = useApp((s) => (focusedPaneId ? s.session.agents[focusedPaneId] : undefined));
  const pane = useApp((s) => (focusedPaneId ? s.session.panes[focusedPaneId] : undefined));
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Reset the draft when the focused agent changes.
  useEffect(() => {
    setText("");
  }, [focusedPaneId]);

  if (!focusedPaneId || !agent) return null;

  const blocked = agent.agent_status === "blocked";
  const name = paneTitle(pane, agent);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    const max = 4 * 19 + 8; // ~four lines
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  };

  const send = () => {
    const value = text.trim();
    if (!value || blocked) return;
    void call("agent.prompt", { target: focusedPaneId, text: value });
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      focusTerminal(focusedPaneId);
      return;
    }
    if (e.key !== "Enter" || isComposing(e)) return;
    if (e.shiftKey) return; // Shift+Enter is always a newline.
    e.preventDefault();
    send();
  };

  return (
    <div className="composer">
      <div className="composer-field">
        <span className="composer-glow" aria-hidden="true" />
        <span className="composer-meta">
          <StatusBadge status={agent.agent_status} muted={agent.agent_status === "unknown"} />
          <span className="composer-name">{name}</span>
        </span>
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={blocked ? "Blocked — answer in the terminal" : "Message the agent…  (Enter to send)"}
          disabled={blocked}
          onChange={(e) => {
            setText(e.target.value);
            grow(e.target);
          }}
          onKeyDown={onKeyDown}
          aria-label={`Message ${name}`}
        />
        <button className="composer-send" onClick={send} disabled={blocked || !text.trim()} aria-label="Send" title="Send (Enter)">
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}
