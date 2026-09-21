import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ExternalLink, MessageSquareDashed, MousePointerClick, Trash2 } from "lucide-react";
import type { AnnotatorMessage, ReviewComment, ReviewSession } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import {
  endReviewSession,
  getReviewSession,
  getReviewSessions,
  postReviewFeedback,
  reviewArtifactUrl,
} from "../api/client.ts";
import { StatusBadge } from "./StatusBadge.tsx";

const POLL_MS = 5000;

function basename(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? file : file.slice(i + 1);
}

/** "just now", "4m", "3h", "2d" — enough to tell fresh from stale at a glance. */
function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** A comment the human has written but not yet sent, with a local id for the list. */
interface Draft extends ReviewComment {
  id: string;
}

let draftSeq = 0;

/**
 * Review: the artifacts agents publish, and the comments a person anchors to
 * them.
 *
 * The frame is the delicate part. It holds markup an agent wrote, inside the
 * authenticated app, so it carries `sandbox="allow-scripts"` — no same-origin,
 * no forms, no top-level navigation — and the bridge sends the same guarantee
 * as a CSP header on the artifact itself. Its origin is therefore opaque, which
 * is why the only traffic across the boundary is `postMessage`: the annotator
 * reports what was clicked or selected, and this panel replies with the
 * annotate mode and, when a comment is clicked, a selector to scroll to.
 */
export function ReviewPanel() {
  const selected = useApp((s) => s.ui.inspector.reviewKey);
  const setInspector = useApp((s) => s.setInspector);
  const reportRpcError = useApp((s) => s.reportRpcError);

  const [sessions, setSessions] = useState<ReviewSession[] | null>(null);
  const [current, setCurrent] = useState<ReviewSession | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [note, setNote] = useState("");
  const [annotating, setAnnotating] = useState(false);
  const [sending, setSending] = useState(false);
  // Draft ids whose anchor no longer resolves in the (possibly republished)
  // artifact; for those we reveal the quoted text instead of scrolling.
  const [unresolved, setUnresolved] = useState<Record<string, boolean>>({});
  const frame = useRef<HTMLIFrameElement | null>(null);
  // Which draft's scroll we last requested, so a scroll result can be attributed.
  const lastScroll = useRef<string | null>(null);

  // Refresh the list while the panel is mounted: sessions appear when an agent
  // runs the CLI, which this app has no event stream for.
  useEffect(() => {
    let live = true;
    const load = () =>
      getReviewSessions()
        .then((s) => live && setSessions(s))
        .catch(() => {});
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  // The selected session is fetched by key rather than picked out of the list,
  // so the URL the CLI prints opens straight onto it without waiting for one.
  useEffect(() => {
    setDrafts([]);
    setNote("");
    setAnnotating(false);
    setUnresolved({});
    lastScroll.current = null;
    if (!selected) {
      setCurrent(null);
      return;
    }
    let live = true;
    const load = () =>
      getReviewSession(selected)
        .then((d) => live && setCurrent(d.session))
        .catch(() => live && setCurrent(null));
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [selected]);

  const tell = useCallback((message: Record<string, unknown>) => {
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    frame.current?.contentWindow?.postMessage(message, "*");
  }, []);

  useEffect(() => {
    tell({ mode: annotating ? "on" : "off" });
  }, [annotating, tell]);

  // Anchors picked inside the frame. The source check is what keeps another
  // frame or window from injecting comments into this list.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as Partial<AnnotatorMessage> | null;
      if (!data || data.source !== "agentbox-review") return;
      if (data.kind === "scrolled") {
        // The artifact told us whether the anchor still resolves. When it does
        // not, mark the draft so its quote is shown in place of a dead scroll.
        const id = lastScroll.current;
        if (id) setUnresolved((u) => ({ ...u, [id]: data.ok === false }));
        return;
      }
      if (data.kind !== "element" && data.kind !== "selection") return;
      const anchor = typeof data.selector === "string" ? data.selector : "";
      const quote = typeof data.text === "string" ? data.text : "";
      setDrafts((d) => [
        ...d,
        { id: `d${++draftSeq}`, kind: data.kind as Draft["kind"], anchor, quote, note: "" },
      ]);
      setAnnotating(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const send = async (end: boolean) => {
    if (!current) return;
    const trimmed = note.trim();
    const outgoing: ReviewComment[] = drafts
      .filter((d) => d.note.trim())
      .map((d) => {
        const c: ReviewComment = { kind: d.kind, note: d.note.trim() };
        if (d.anchor) c.anchor = d.anchor;
        if (d.quote) c.quote = d.quote;
        return c;
      });
    if (trimmed) outgoing.push({ kind: "note", note: trimmed });
    if (outgoing.length === 0 && !end) return;
    setSending(true);
    try {
      const detail = await postReviewFeedback(current.key, outgoing, end);
      setDrafts([]);
      setNote("");
      setCurrent(detail.session);
      setSessions(await getReviewSessions());
      if (end) setInspector({ reviewKey: null });
    } catch (err) {
      reportRpcError("review feedback", err);
    } finally {
      setSending(false);
    }
  };

  const endNow = async () => {
    if (!current) return;
    try {
      setCurrent(await endReviewSession(current.key));
      setSessions(await getReviewSessions());
      setInspector({ reviewKey: null });
    } catch (err) {
      reportRpcError("review end", err);
    }
  };

  if (sessions === null) {
    return (
      // A layout-matching placeholder, never a bare spinner: the list settles
      // into the shape it was already holding.
      <div className="review">
        <div className="review-loading" aria-hidden="true">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="review">
        <ul className="review-sessions">
          {sessions.map((s) => (
            <li key={s.key}>
              <button className="review-row" onClick={() => setInspector({ reviewKey: s.key })}>
                <StatusBadge
                  status={s.status === "open" ? "working" : "done"}
                  muted={s.status !== "open"}
                  title={s.status}
                />
                <span className="review-label">{s.label}</span>
                {s.pending > 0 && <span className="review-count">{s.pending}</span>}
                <span className="review-file">{basename(s.file)}</span>
                <span className="review-age">{ago(s.updated)}</span>
              </button>
            </li>
          ))}
        </ul>
        {sessions.length === 0 && (
          <div className="empty">
            <span className="empty-glyph" aria-hidden="true">
              <MessageSquareDashed size={22} />
            </span>
            <p className="empty-title">Nothing to review.</p>
            <p className="empty-sub">An agent publishes a page here with one command:</p>
            <pre className="empty-code">agentbox-review open plan.html</pre>
          </div>
        )}
      </div>
    );
  }

  const ended = current.status !== "open";
  const artifact = reviewArtifactUrl(current.key);

  return (
    <div className="review">
      <div className="review-bar">
        <button className="icon-btn" aria-label="Back to sessions" onClick={() => setInspector({ reviewKey: null })}>
          <ChevronLeft size={15} />
        </button>
        <span className="review-title">{current.label}</span>
        {!ended && (
          <button
            className={`chip${annotating ? " is-active" : ""}`}
            aria-pressed={annotating}
            onClick={() => setAnnotating((v) => !v)}
          >
            <MousePointerClick size={13} /> Annotate
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Open full screen"
          title="Open full screen"
          onClick={() => window.open(artifact, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink size={14} />
        </button>
      </div>

      <iframe
        ref={frame}
        className="review-frame"
        // The agent's markup runs with an opaque origin and no same-origin
        // access; the bridge repeats this as a CSP header on the response.
        sandbox="allow-scripts"
        src={artifact}
        title={`Review artifact ${current.label}`}
      />

      {annotating && <p className="review-hint">Click an element, or select some text, to anchor a comment.</p>}

      <div className="review-comments">
        {drafts.map((d) => (
          <div className="review-comment" key={d.id}>
            <button
              className={`review-anchor${unresolved[d.id] ? " is-unresolved" : ""}`}
              title={unresolved[d.id] ? "This anchor no longer resolves in the artifact" : "Scroll the artifact to this"}
              onClick={() => {
                if (!d.anchor) return;
                lastScroll.current = d.id;
                tell({ scrollTo: d.anchor });
              }}
            >
              {d.quote || d.anchor || "element"}
            </button>
            {unresolved[d.id] && (
              <p className="review-anchor-note">
                Couldn&apos;t find this on the page anymore{d.quote ? `; it read: “${d.quote}”` : "."}
              </p>
            )}
            <textarea
              className="review-note"
              rows={2}
              placeholder="What about it?"
              aria-label={`Comment on ${d.quote || d.anchor}`}
              value={d.note}
              onChange={(e) =>
                setDrafts((all) => all.map((x) => (x.id === d.id ? { ...x, note: e.target.value } : x)))
              }
            />
            <button
              className="icon-btn"
              aria-label="Remove comment"
              onClick={() => setDrafts((all) => all.filter((x) => x.id !== d.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {ended ? (
        <p className="review-hint">This session has ended{current.endedBy ? ` (${current.endedBy})` : ""}.</p>
      ) : (
        <div className="review-composer">
          <textarea
            className="review-note"
            rows={2}
            placeholder="A note about the whole thing…"
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="review-actions">
            <button className="btn btn-small btn-primary" disabled={sending} onClick={() => void send(false)}>
              Send
            </button>
            <button className="btn btn-small" disabled={sending} onClick={() => void send(true)}>
              Send &amp; end
            </button>
            <button className="btn btn-small" disabled={sending} onClick={() => void endNow()}>
              End
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
