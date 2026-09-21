import { useApp } from "../store/app.ts";
import { actionCtx } from "../api/call.ts";
import { PrefixMachine } from "./prefix.ts";
import { comboFromEvent } from "./combo.ts";
import { DEFAULT_BINDINGS, runAction } from "./actions.ts";

/**
 * One prefix machine for the whole app: arming is global, so a prefix pressed
 * in one pane and its follow-up (even after focus moves, or with no terminal
 * focused at all) resolve together, and the HUD reflects a single armed state.
 */
export const machine = new PrefixMachine("ctrl+b", DEFAULT_BINDINGS);

let hudTimer: ReturnType<typeof setTimeout> | null = null;

/** Mirror the machine's armed state into the store so the HUD pill can show it. */
export function reflectHud(): void {
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

/**
 * True when a keystroke belongs to a text field (including xterm's hidden
 * helper textarea, which the terminal cell handles itself) and the
 * document-level prefix layer must keep its hands off.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/**
 * The document-level half of the prefix layer. Terminals feed the machine
 * themselves through xterm's key handler; this covers everything else, so the
 * bindings keep working once focus leaves a terminal — after prefix+q, say, or
 * while the sidebar has focus. Text fields and open overlays are left alone.
 *
 * Returns true when the keystroke was consumed.
 */
export function feedGlobal(e: KeyboardEvent): boolean {
  if (isTextEntry(e.target)) return false;
  const { ui } = useApp.getState();
  if (ui.palette || ui.dialog) return false;
  const r = machine.feed(comboFromEvent(e));
  reflectHud();
  if (!r.consumed) return false;
  e.preventDefault();
  e.stopPropagation();
  if (r.action) runAction(r.action, actionCtx());
  return true;
}
