import { useApp } from "../store/app.ts";
import { call } from "../api/call.ts";
import { paneTitle } from "../store/session.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { focusTerminal } from "../terminal/registry.ts";
import { paneMode, useTermModes } from "../terminal/modes.ts";
import { ComposeField } from "./ComposeField.tsx";

/**
 * The agent composer, under the grid when the focused pane hosts an agent:
 * the text goes to herdr as a prompt (`agent.prompt`), not as keystrokes.
 * Enter sends, Shift+Enter starts a new line. herdr refuses prompts to
 * blocked agents, so the field disables itself and says why. Escape returns
 * focus to the terminal. A pane with its own compose bar does without it.
 */
export function Composer() {
  const focusedPaneId = useApp((s) => s.session.focusedPaneId);
  const agent = useApp((s) => (focusedPaneId ? s.session.agents[focusedPaneId] : undefined));
  const pane = useApp((s) => (focusedPaneId ? s.session.panes[focusedPaneId] : undefined));
  const composeBar = useTermModes((s) => (focusedPaneId ? paneMode(s, focusedPaneId, "compose") : false));

  if (!focusedPaneId || !agent || composeBar) return null;

  const blocked = agent.agent_status === "blocked";
  const name = paneTitle(pane, agent);

  return (
    <ComposeField
      // A fresh draft for each agent.
      key={focusedPaneId}
      label={`Message ${name}`}
      placeholder={blocked ? "Blocked — answer in the terminal" : "Message the agent…  (Enter to send)"}
      disabled={blocked}
      meta={
        <>
          <StatusBadge status={agent.agent_status} muted={agent.agent_status === "unknown"} />
          <span className="composer-name">{name}</span>
        </>
      }
      onSubmit={(text) => {
        const value = text.trim();
        if (!value || blocked) return false;
        void call("agent.prompt", { target: focusedPaneId, text: value });
        return true;
      }}
      onKey={(e) => {
        if (e.key !== "Escape") return false;
        e.preventDefault();
        focusTerminal(focusedPaneId);
        return true;
      }}
    />
  );
}
