import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictation through the browser's own Web Speech API. Chrome, Edge and Safari
 * have it (Chrome sends the audio to its speech service); Firefox and many
 * Chromium builds do not, and the mic button says so instead of appearing to
 * work. Nothing here records or uploads anything itself.
 */

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}
export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function dictationSupported(): boolean {
  return ctor() !== null;
}

export const UNSUPPORTED_HINT = "Dictation needs a browser with speech recognition, such as Chrome, Edge or Safari";

/** What a recognition error means to the person at the mic. */
export function dictationError(code: string): string | null {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone blocked — allow it for this site in the browser's address bar";
    case "audio-capture":
      return "No microphone found";
    case "network":
      return "The browser's speech service could not be reached";
    case "no-speech":
    case "aborted":
      return null;
    default:
      return `Dictation stopped (${code})`;
  }
}

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** Words heard but not settled yet. */
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}

/**
 * One recogniser per field. Settled text goes to `onFinal` (the field inserts
 * it at the caret; nothing is sent); the unsettled tail is `interim`.
 */
export function useDictation(onFinal: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const final = useRef(onFinal);
  final.current = onFinal;
  const supported = dictationSupported();

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    const C = ctor();
    if (!C || rec.current) return;
    const r = new C();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let tail = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) final.current(res[0].transcript.trim());
        else tail += res[0].transcript;
      }
      setInterim(tail.trim());
    };
    r.onerror = (e) => setError(dictationError(e.error));
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    rec.current = r;
    setError(null);
    try {
      r.start(); // the browser asks for the microphone here, the first time
      setListening(true);
    } catch {
      rec.current = null;
    }
  }, []);

  const toggle = useCallback(() => (rec.current ? stop() : start()), [start, stop]);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported, listening, interim, error, start, stop, toggle };
}

/** `text` inserted into `value` at [start, end), spaced from its neighbours. */
export function insertAt(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const ins = pre + text + post;
  return { value: before + ins + after, caret: before.length + pre.length + text.length };
}

/** Push-to-talk: ⌃⌥M (Ctrl+Alt+M), held to talk, or tapped to start and stop. */
export function isTalkKey(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): boolean {
  return e.code === "KeyM" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;
}
