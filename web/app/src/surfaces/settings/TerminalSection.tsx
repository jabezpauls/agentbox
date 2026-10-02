import { useId } from "react";
import { Section } from "../../components/ui/Page.tsx";
import { useTermModes } from "../../terminal/modes.ts";
import { dictationSupported } from "../../lib/dictation.ts";

function Toggle({ label, hint, on, set }: { label: string; hint: string; on: boolean; set(on: boolean): void }) {
  const id = useId();
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <strong id={`${id}-l`}>{label}</strong>
        <span id={`${id}-h`}>{hint}</span>
      </div>
      <button
        className={`switch${on ? " is-on" : ""}`}
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-h`}
        onClick={() => set(!on)}
      >
        <span className="switch-knob" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Settings → Terminal: how the Workbench's terminals take typing, by default. */
export function TerminalSection() {
  const predict = useTermModes((s) => s.predict);
  const compose = useTermModes((s) => s.compose);
  const setDefault = useTermModes((s) => s.setDefault);
  return (
    <Section title="Typing" id="typing">
      <div className="settings-card">
        <Toggle
          label="Predictive echo"
          hint="On a slow link, show what you type at once, underlined until the box echoes it — as mosh does. Keys still go straight to the program; a wrong guess is wiped. Only while the round trip is over 30 ms."
          on={predict}
          set={(on) => setDefault("predict", on)}
        />
        <Toggle
          label="Compose bar"
          hint="Type a line under the terminal and send it with Enter, with its own history. Steps aside for full-screen programs. Each pane's menu can override this."
          on={compose}
          set={(on) => setDefault("compose", on)}
        />
      </div>
      <p className="field-hint">
        Kept in this browser.{" "}
        {dictationSupported()
          ? "Dictation (the microphone in the compose bars) uses this browser's speech recognition."
          : "Dictation needs a browser with speech recognition, such as Chrome, Edge or Safari."}
      </p>
    </Section>
  );
}
