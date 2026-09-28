import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Dialog } from "../dialogs/Dialog.tsx";

/**
 * Imperative dialogs: `await confirm({...})` and `await promptText({...})`,
 * resolved by one host mounted in the shell. Never `window.confirm` — a
 * browser popup is outside the app's design, its focus handling and its
 * theme.
 */

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  /** The real verb: "Delete", "Stop sharing", "Revoke". */
  confirmLabel: string;
  /** Destructive by default: the confirm is the danger button. */
  tone?: "danger" | "default";
}

interface TextOpts {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  /** Select this much of the initial value (a name without its extension). */
  selectTo?: number;
  /** A sentence saying what is wrong, or null when it is fine. */
  validate?(value: string): string | null;
  body?: ReactNode;
}

type Pending =
  | { kind: "confirm"; opts: ConfirmOpts; resolve(v: boolean): void }
  | { kind: "text"; opts: TextOpts; resolve(v: string | null): void };

const usePrompts = create<{ pending: Pending | null }>(() => ({ pending: null }));

function settleCurrent(): void {
  const p = usePrompts.getState().pending;
  if (p?.kind === "confirm") p.resolve(false);
  else if (p?.kind === "text") p.resolve(null);
}

/** Answer "no" to whatever is being asked, and close it (moving to another surface). */
export function dismissPrompts(): void {
  settleCurrent();
  usePrompts.setState({ pending: null });
}

export function confirm(opts: ConfirmOpts): Promise<boolean> {
  settleCurrent();
  return new Promise((resolve) => usePrompts.setState({ pending: { kind: "confirm", opts, resolve } }));
}

export function promptText(opts: TextOpts): Promise<string | null> {
  settleCurrent();
  return new Promise((resolve) => usePrompts.setState({ pending: { kind: "text", opts, resolve } }));
}

function TextPrompt({ opts, done }: { opts: TextOpts; done(v: string | null): void }) {
  const [value, setValue] = useState(opts.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, opts.selectTo ?? el.value.length);
  }, [opts.selectTo]);

  const submit = () => {
    const v = value.trim();
    const problem = v ? (opts.validate?.(v) ?? null) : "Enter a name.";
    if (problem) {
      setError(problem);
      input.current?.focus();
      return;
    }
    done(v);
  };

  return (
    <Dialog title={opts.title} narrow onClose={() => done(null)} onSubmit={submit} submitLabel={opts.confirmLabel}>
      {opts.body}
      <label className="field">
        <span className="field-label">{opts.label}</span>
        <input
          ref={input}
          className={`input${error ? " is-invalid" : ""}`}
          value={value}
          placeholder={opts.placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "prompt-error" : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <span id="prompt-error" className="field-error" role="alert">
            {error}
          </span>
        )}
      </label>
    </Dialog>
  );
}

/** Mounted once, in the shell. */
export function PromptHost() {
  const pending = usePrompts((s) => s.pending);
  if (!pending) return null;
  const finish = () => usePrompts.setState({ pending: null });

  if (pending.kind === "confirm") {
    const { opts } = pending;
    const answer = (v: boolean) => {
      finish();
      pending.resolve(v);
    };
    return (
      <Dialog
        title={opts.title}
        narrow
        danger={(opts.tone ?? "danger") === "danger"}
        autoFocusSubmit
        onClose={() => answer(false)}
        onSubmit={() => answer(true)}
        submitLabel={opts.confirmLabel}
      >
        {opts.body && <div className="dialog-text">{opts.body}</div>}
      </Dialog>
    );
  }
  return (
    <TextPrompt
      opts={pending.opts}
      done={(v) => {
        finish();
        pending.resolve(v);
      }}
    />
  );
}
