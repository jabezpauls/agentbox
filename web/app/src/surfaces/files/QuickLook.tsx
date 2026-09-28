import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Code2, Download, FileQuestion, X } from "lucide-react";
import type { FileEntry } from "@workbench/shared";
import { download, rawUrl } from "../../files/api.ts";
import { loadMarkdown, previewKind, readText, type TextPreview } from "../../files/preview.ts";
import type { Rendered } from "../../files/markdown.ts";
import { formatAgo, formatBytes } from "../../lib/format.ts";
import { useFocusTrap } from "../../components/ui/focus.ts";
import { openInEditor } from "../../shell/editor.ts";
import { GitMark, iconFor } from "./icons.tsx";

interface Props {
  entry: FileEntry;
  /** The files around it, for ← and →. */
  siblings: FileEntry[];
  onNavigate(entry: FileEntry): void;
  onClose(): void;
}

function TextBody({ preview }: { preview: TextPreview }) {
  const lines = useMemo(() => preview.text.replace(/\n$/, "").split("\n"), [preview.text]);
  return (
    <div className="ql-text">
      <pre className="ql-pre">
        <code>
          {lines.map((l, i) => (
            <span className="ql-line" key={i}>
              <span className="ql-ln" aria-hidden="true">
                {i + 1}
              </span>
              {l || " "}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      {preview.truncated && <p className="ql-note">Showing the first 256 KB. Open it in the editor for the rest.</p>}
    </div>
  );
}

/**
 * Quick look: a file, shown as what it is, over the list — text and code,
 * rendered Markdown, pictures and PDFs — with the editor and a download one
 * step away. ← and → walk the folder's files; Escape or Space close it.
 */
export function QuickLook({ entry, siblings, onNavigate, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const kind = previewKind(entry);
  const [text, setText] = useState<TextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);

  useFocusTrap(ref, true, { onEscape: onClose, initial: () => ref.current });

  useEffect(() => {
    setText(null);
    setError(null);
    setSource(false);
    if (kind !== "text" && kind !== "markdown") return;
    const abort = new AbortController();
    readText(entry.path, abort.signal)
      .then(setText)
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => abort.abort();
  }, [entry.path, kind]);

  const files = siblings.filter((s) => s.type === "file" || (s.type === "symlink" && s.targetType === "file"));
  const at = files.findIndex((f) => f.path === entry.path);
  const prev = at > 0 ? files[at - 1] : undefined;
  const next = at >= 0 && at < files.length - 1 ? files[at + 1] : undefined;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest("button,a,input")) return;
    if (e.key === "ArrowLeft" && prev) onNavigate(prev);
    else if (e.key === "ArrowRight" && next) onNavigate(next);
    else if (e.key === " ") onClose();
    else return;
    e.preventDefault();
  };

  // Markdown is rendered by a module fetched the first time it is needed.
  const [remoteImages, setRemoteImages] = useState(false);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  // The renderer's module could not be fetched (the connection dropped, or
  // the box was updated under this page): say so, and fetch it again on ask.
  const [renderFailed, setRenderFailed] = useState(false);
  const [renderTry, setRenderTry] = useState(0);
  useEffect(() => setRemoteImages(false), [entry.path]);
  useEffect(() => {
    setRendered(null);
    setRenderFailed(false);
    if (kind !== "markdown" || !text || text.binary) return;
    let live = true;
    loadMarkdown().then(
      (m) => {
        if (live) setRendered(m.renderMarkdown(text.text, entry.path, { remoteImages }));
      },
      () => {
        if (live) setRenderFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [kind, text, entry.path, remoteImages, renderTry]);

  const Icon = iconFor(entry);
  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="empty">
        <p className="empty-title">Couldn't read it.</p>
        <p className="empty-sub">{error}</p>
      </div>
    );
  } else if (kind === "image") {
    body = (
      <div className="ql-media">
        <img src={rawUrl(entry.path, true)} alt={entry.name} />
      </div>
    );
  } else if (kind === "pdf") {
    // No `sandbox` attribute: Chromium refuses a PDF in a sandboxed frame. The
    // response's own `CSP: sandbox` already gives it an opaque origin.
    body = <iframe className="ql-pdf" src={rawUrl(entry.path, true)} title={entry.name} />;
  } else if ((kind === "text" || kind === "markdown") && !text) {
    body = (
      <div className="ql-loading" aria-busy="true">
        {[70, 90, 55, 80, 40].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%`, height: 12 }} />
        ))}
      </div>
    );
  } else if (text && !text.binary && kind === "markdown" && !source && renderFailed) {
    body = (
      <div className="empty">
        <p className="empty-title">Couldn't show it formatted.</p>
        <p className="empty-sub">The part of the app that formats Markdown did not load. The source is one click away.</p>
        <div className="empty-actions">
          <button className="btn btn-small" onClick={() => setRenderTry((n) => n + 1)}>
            Try again
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => setSource(true)}>
            Show the source
          </button>
        </div>
      </div>
    );
  } else if (text && !text.binary && kind === "markdown" && !source) {
    body = rendered ? (
      <>
        {rendered.blocked > 0 && (
          <div className="ql-bar" role="status">
            <span>
              {rendered.blocked === 1 ? "A picture from another site was not loaded" : `${rendered.blocked} pictures from other sites were not loaded`}, so
              nobody learns you looked.
            </span>
            <button className="btn btn-small" onClick={() => setRemoteImages(true)}>
              Load remote images
            </button>
          </div>
        )}
        <div className="ql-markdown markdown" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      </>
    ) : (
      <div className="ql-loading" aria-busy="true">
        <div className="skeleton" style={{ width: "40%", height: 18 }} />
        <div className="skeleton" style={{ width: "80%", height: 12 }} />
      </div>
    );
  } else if (text && !text.binary) {
    body = text.text === "" ? <div className="empty"><p className="empty-title">This file is empty.</p></div> : <TextBody preview={text} />;
  } else {
    body = (
      <div className="empty">
        <span className="empty-glyph" aria-hidden="true">
          <FileQuestion size={22} />
        </span>
        <p className="empty-title">No preview for this kind of file.</p>
        <p className="empty-sub">Download it, or open it in the editor.</p>
      </div>
    );
  }

  return (
    <div className="scrim ql-scrim" onMouseDown={onClose}>
      <div
        ref={ref}
        className="ql pop-in"
        role="dialog"
        aria-modal="true"
        aria-label={`Quick look: ${entry.name}`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="ql-head">
          <span className="ql-icon" aria-hidden="true">
            <Icon size={16} strokeWidth={1.75} />
          </span>
          <div className="ql-title">
            <h2 className="ql-name" title={entry.path}>
              {entry.name}
            </h2>
            <p className="ql-meta">
              {formatBytes(entry.size)} · changed {formatAgo(entry.mtime)}
              {entry.git && (
                <>
                  {" "}
                  · <GitMark status={entry.git} />
                </>
              )}
            </p>
          </div>
          {kind === "markdown" && text && !text.binary && (
            <div className="segmented" role="radiogroup" aria-label="Show">
              <button role="radio" aria-checked={!source} className={`segmented-btn${!source ? " is-active" : ""}`} onClick={() => setSource(false)}>
                Preview
              </button>
              <button role="radio" aria-checked={source} className={`segmented-btn${source ? " is-active" : ""}`} onClick={() => setSource(true)}>
                Source
              </button>
            </div>
          )}
          <div className="ql-actions">
            <button className="btn btn-small" onClick={() => {
                onClose();
                void openInEditor(entry.path);
              }}>
              <Code2 size={14} aria-hidden="true" />
              Open in editor
            </button>
            <button className="icon-btn" aria-label="Download" title="Download" onClick={() => download(rawUrl(entry.path))}>
              <Download size={15} />
            </button>
            <span className="ql-nav">
              <button className="icon-btn" aria-label="Previous file" title="Previous (←)" disabled={!prev} onClick={() => prev && onNavigate(prev)}>
                <ChevronLeft size={16} />
              </button>
              <button className="icon-btn" aria-label="Next file" title="Next (→)" disabled={!next} onClick={() => next && onNavigate(next)}>
                <ChevronRight size={16} />
              </button>
            </span>
            <button className="icon-btn" data-close aria-label="Close" title="Close (Esc)" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        <div className={`ql-body is-${kind}`}>{body}</div>
      </div>
    </div>
  );
}
