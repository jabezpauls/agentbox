import { useEffect, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { useApp } from "../store/app.ts";
import { call } from "../api/call.ts";
import { paneTitle } from "../store/session.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { focusTerminal } from "../terminal/registry.ts";

/**
 * A single-line (growing to four) composer shown under the grid when the
 * focused pane hosts an agent. ⌘/Ctrl+Enter sends the text through
 * `agent.prompt`, so an agent can be answered without clicking into its
 * terminal. herdr refuses prompts to blocked agents, so the field disables
 * itself and says why. Escape returns focus to the terminal.
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
    const max = 4 * 20 + 16; // ~four lines
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
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      focusTerminal(focusedPaneId);
    }
  };

  return (
    <div className="composer">
      <div className="composer-meta">
        <StatusBadge status={agent.agent_status} muted={agent.agent_status === "unknown"} />
        <span className="composer-name">{name}</span>
      </div>
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        value={text}
        placeholder={blocked ? "Agent is blocked — answer in the terminal" : `Message ${name}…  (⌘/Ctrl+Enter to send)`}
        disabled={blocked}
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={onKeyDown}
        aria-label={`Message ${name}`}
      />
      <button className="composer-send" onClick={send} disabled={blocked || !text.trim()} aria-label="Send">
        <CornerDownLeft size={16} />
      </button>
    </div>
  );
}
