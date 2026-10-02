import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Mic, MicOff } from "lucide-react";
import { UNSUPPORTED_HINT, insertAt, isTalkKey, useDictation } from "../lib/dictation.ts";

/**
 * Whether a key event is part of an in-flight IME composition. A CJK
 * composition commit arrives as an Enter with `isComposing` set (and, in some
 * browsers, only as `keyCode === 229`), and both flags can live on either the
 * synthetic event or the native one. Send on such an Enter and the user's
 * half-finished word goes out instead of being committed.
 */
function isComposing(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
  return Boolean(e.nativeEvent.isComposing || native.isComposing) || e.keyCode === 229 || native.keyCode === 229;
}

/** What a field's own key handler may do with the draft. */
export interface FieldCtx {
  text: string;
  el: HTMLTextAreaElement;
  clear(): void;
}

interface Props {
  label: string;
  placeholder: string;
  disabled?: boolean;
  /** Shown at the field's start: who the text goes to. */
  meta?: ReactNode;
  /** Earlier sends, oldest first: ↑ on the first line and ↓ on the last walk them. */
  history?: string[];
  /** Enter. Return true to clear the field. */
  onSubmit(text: string): boolean;
  /** Keys the owner takes before the field does; true when taken. */
  onKey?(e: React.KeyboardEvent<HTMLTextAreaElement>, ctx: FieldCtx): boolean;
  /** Whether Send is enabled with nothing typed (a terminal takes a bare Enter). */
  sendEmpty?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onFocusChange?(focused: boolean): void;
  /** Under the field: quick keys. */
  children?: ReactNode;
  className?: string;
}

const MAX_HEIGHT = 4 * 19 + 8; // ~four lines
/** A ⌃⌥M held longer than this is push-to-talk; shorter, a toggle. */
const HOLD_MS = 400;

/**
 * The text field the agent composer and the terminal compose bar share:
 * multi-line (Shift+Enter), growing to four lines, IME-safe Enter, an optional
 * history, and dictation — the mic button, or ⌃⌥M held to talk — whose words
 * land at the caret and are never sent on their own.
 */
export function ComposeField({ label, placeholder, disabled, meta, history, onSubmit, onKey, sendEmpty, inputRef, onFocusChange, children, className }: Props) {
  const [text, setText] = useState("");
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;
  // Where ↑/↓ are in the history (null: the draft), and the draft kept aside.
  const walk = useRef<{ i: number | null; draft: string }>({ i: null, draft: "" });
  const talk = useRef<{ at: number; was: boolean } | null>(null);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  };
  useEffect(grow, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = (value: string, caret = value.length) => {
    setText(value);
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
  };

  const dictation = useDictation((heard) => {
    if (!heard) return;
    const el = ref.current;
    const v = el?.value ?? "";
    const r = insertAt(v, el?.selectionStart ?? v.length, el?.selectionEnd ?? v.length, heard);
    put(r.value, r.caret);
  });

  const clear = () => {
    setText("");
    walk.current = { i: null, draft: "" };
  };

  const submit = () => {
    if (disabled) return;
    if (onSubmit(text)) clear();
  };

  const recall = (el: HTMLTextAreaElement, dir: -1 | 1): boolean => {
    if (!history?.length || el.selectionStart !== el.selectionEnd) return false;
    const w = walk.current;
    if (dir < 0 && text.slice(0, el.selectionStart).includes("\n")) return false;
    if (dir > 0 && (w.i === null || text.slice(el.selectionEnd).includes("\n"))) return false;
    if (dir < 0) {
      if (w.i === null) w.draft = text;
      w.i = w.i === null ? history.length - 1 : Math.max(0, w.i - 1);
      put(history[w.i]!);
    } else {
      w.i = w.i! + 1;
      if (w.i >= history.length) {
        w.i = null;
        put(w.draft);
      } else put(history[w.i]!);
    }
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isTalkKey(e.nativeEvent)) {
      e.preventDefault();
      if (!e.repeat && dictation.supported) {
        talk.current = { at: performance.now(), was: dictation.listening };
        if (!dictation.listening) dictation.start();
      }
      return;
    }
    if (isComposing(e)) return;
    if (onKey?.(e, { text, el: e.currentTarget, clear })) return;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (recall(e.currentTarget, e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return; // Shift+Enter is always a newline.
    e.preventDefault();
    submit();
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = talk.current;
    if (!t || e.code !== "KeyM") return;
    talk.current = null;
    // A tap toggles; a hold talks until let go.
    if (t.was || performance.now() - t.at > HOLD_MS) dictation.stop();
  };

  const micTitle = !dictation.supported
    ? UNSUPPORTED_HINT
    : (dictation.error ?? (dictation.listening ? "Stop dictation (Ctrl+Alt+M)" : "Dictate (Ctrl+Alt+M, hold to talk)"));

  return (
    <div className={`composer ${className ?? ""}`}>
      <div className="composer-field">
        <span className="composer-glow" aria-hidden="true" />
        {meta && <span className="composer-meta">{meta}</span>}
        <div className="composer-text">
          {dictation.interim && (
            <div className="composer-interim" aria-live="polite">
              {dictation.interim}
            </div>
          )}
          <textarea
            ref={ref}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              walk.current.i = null;
            }}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            aria-label={label}
          />
        </div>
        <button
          className={`composer-mic${dictation.listening ? " is-on" : ""}${dictation.error ? " is-error" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => dictation.supported && !disabled && dictation.toggle()}
          // aria-disabled rather than disabled, so the tooltip saying why still shows.
          aria-disabled={!dictation.supported || disabled}
          aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
          aria-pressed={dictation.listening}
          title={micTitle}
        >
          {dictation.supported ? <Mic size={15} /> : <MicOff size={15} />}
        </button>
        <button
          className="composer-send"
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
          disabled={disabled || (!sendEmpty && !text.trim())}
          aria-label="Send"
          title="Send (Enter)"
        >
          <ArrowUp size={15} />
        </button>
      </div>
      {dictation.error && (
        <p className="composer-error" role="status">
          {dictation.error}
        </p>
      )}
      {children}
    </div>
  );
}
