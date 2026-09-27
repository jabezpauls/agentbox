import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Code2 } from "lucide-react";
import { handleChord } from "../../shell/actions.ts";
import { useOnActivate } from "../../shell/activity.tsx";
import { useEditorState } from "../../shell/editor.ts";

/**
 * Frame documents the chord listener is already on, so it never runs twice.
 * Keyed by document, not window: a frame keeps its window object across a
 * reload but gets a new document, and the listener has to go on again.
 */
const listening = new WeakSet<Document>();

/** Where code-server lives, behind the gate. */
export const EDITOR_URL = "/vscode/";

/**
 * The frame itself, memoised with no props, so nothing the surface around it
 * does can make React touch it: the iframe is created once and is never
 * recreated, which would reload the whole editor and lose unsaved state.
 */
const EditorFrame = memo(function EditorFrame({ onFrame }: { onFrame(el: HTMLIFrameElement | null): void }) {
  return <iframe ref={onFrame} className="editor-frame" src={EDITOR_URL} title="Editor" allow="clipboard-read; clipboard-write" />;
});

/**
 * The editor: code-server in a frame, built on the first visit and kept for
 * the life of the page. Inside it VS Code owns the keyboard — ⌘K is its chord
 * — so the shell listens on the frame's own window (same origin, behind the
 * gate) for the ⌃⌥ chords only, which VS Code does not bind.
 */
export function EditorSurface() {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const opening = useEditorState((s) => s.opening);

  const attach = useCallback(() => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    const onKey = (e: KeyboardEvent) => {
      if (handleChord(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    try {
      if (listening.has(win.document)) return;
      win.addEventListener("keydown", onKey, true);
      listening.add(win.document);
    } catch {
      // Not same-origin (a proxy in between that moved it): the chords then
      // work everywhere but inside the editor.
    }
  }, []);

  const onFrame = useCallback(
    (el: HTMLIFrameElement | null) => {
      frame.current = el;
      if (!el) return;
      // Every load is a fresh window (VS Code's "Reload Window" included), so
      // the listener goes on again each time.
      el.addEventListener("load", () => {
        setLoaded(true);
        attach();
      });
    },
    [attach],
  );

  useOnActivate(() => {
    requestAnimationFrame(() => frame.current?.focus());
  });

  // A frame that never finishes loading still gets the chords once it can.
  useEffect(() => {
    const id = setTimeout(attach, 4000);
    return () => clearTimeout(id);
  }, [attach]);

  return (
    <div className="editor" aria-busy={!loaded || undefined}>
      {opening && <div className="progress-sweep" role="progressbar" aria-label="Opening in the editor" />}
      <EditorFrame onFrame={onFrame} />
      {!loaded && (
        <div className="editor-loading" role="status">
          <span className="empty-glyph" aria-hidden="true">
            <Code2 size={22} />
          </span>
          <p className="empty-title">Starting the editor</p>
          <p className="empty-sub">VS Code is loading. It stays running while you use the rest of the app.</p>
        </div>
      )}
    </div>
  );
}
