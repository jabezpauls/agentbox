# Review: an agent-to-human review surface inside Workbench

> **Superseded in part by [2026-09-28-one-app-design.md](2026-09-28-one-app-design.md):** Review now lives in the app's dock, and its API is under `/api/review`, not `/workbench/api`.

Status: approved design, September 2026. Supersedes the lavish-axi integration.

## Purpose

An agent often has something to show rather than tell: a plan, a report, a
comparison, a diagram. Prose in a terminal is a poor medium for it, and the
human's response — "this bit is wrong", "swap these two" — is even worse to
express in prose, because it is about a *place* in the artifact.

Review closes that loop. The agent writes an HTML file and runs one command.
The human sees it inside Workbench, clicks the paragraph or selects the phrase
they mean, says what they think, and sends. The agent's command returns with
those comments, each anchored to what it refers to.

This replaces the third-party `lavish-axi`, which agentbox previously bundled
and exposed on its own hostname. Owning it removes an npm dependency, a
container, a Caddy site, two environment variables, and the cross-origin
limitation that prevented sessions rendering in place.

## Why not keep lavish-axi

Three concrete reasons, in order of weight:

1. **It cannot be embedded.** It binds loopback, serves from its own origin,
   uses absolute paths, and sets headers that refuse framing. The panel could
   only ever list sessions and hand off to another tab.
2. **Its chrome is same-origin with the artifact.** The annotation UI and the
   agent-written page share a document, so the page can reach the chrome.
3. **It is a moving dependency** with its own release cadence, telemetry, a
   plugin system, share/publish features, and a playbook router — none of
   which agentbox needs, all of which it would inherit.

## Goals

- One command for the agent to publish an artifact; one blocking command to
  collect the response.
- Comments anchored to an element or a text selection, plus free-form notes.
- The artifact renders *inside* the Workbench inspector, beside the terminals,
  with no second hostname and no second login.
- The agent's HTML cannot touch Workbench: it is sandboxed with an opaque
  origin and talks to the chrome only by `postMessage`.
- Sessions survive restarts and are listed until ended.

## Non-goals

- Publishing or sharing artifacts outside the box, password-protected links,
  static-site export.
- A plugin system, editor integrations, telemetry, playbooks.
- Editing the artifact in place, or a Mermaid whiteboard editor. Comments are
  the whole vocabulary for now.
- CLI compatibility with `lavish-axi`. Agents that expect that binary will not
  find it; the shipped skill teaches the new one.

## Shape

```
agent                         bridge                        browser
─────                         ──────                        ───────
writes plan.html
agentbox-review open plan.html
        └── POST /api/review/sessions ──▶ store session, copy artifact
                                          ◀── { key, url }
        prints the URL                                  inspector lists it
                                                        renders it in an iframe
agentbox-review poll <key>                              human clicks a heading,
        └── GET  .../feedback?wait=1 ──▶ long-poll       types, presses Send
            (blocks)                     ◀── comments ── POST .../feedback
        prints JSON, consumes it
```

## Storage

One directory per session under `~/.agentbox/review/` (the `agentbox_home`
volume, so it survives restarts and updates):

```
~/.agentbox/review/<key>/
  session.json     { key, label, file, created, status, endedBy }
  artifact.html    a copy of the agent's file, taken at open time
  feedback.json    queued comments not yet delivered
```

The key is a short hash of the absolute artifact path, so re-opening the same
file resumes its session rather than accumulating duplicates. A session is
`open`, or `ended` with `endedBy: "agent" | "human"`.

Copying the artifact rather than reading it live is deliberate: the agent keeps
editing its working file, and a review is of the thing as it was shown.

## Bridge surface

All under the configured base path, alongside the existing routes.

| Route | Who calls it | Purpose |
| --- | --- | --- |
| `POST /api/review/sessions` | CLI | Create or resume a session from a file path. Returns `{ key, url, resumed }`. |
| `GET /api/review/sessions` | app | List sessions, newest first. |
| `GET /api/review/:key` | app | One session with its comments. |
| `GET /api/review/:key/artifact` | iframe | The stored HTML with the annotator injected. |
| `POST /api/review/:key/feedback` | app | Queue the human's comments; `{ end: true }` also ends the session. |
| `GET /api/review/:key/feedback?wait=<ms>` | CLI | Long-poll. Returns queued comments and clears the queue. |
| `POST /api/review/:key/end` | CLI, app | End the session. |

The artifact route sets `Content-Security-Policy: sandbox allow-scripts` and
`X-Content-Type-Options: nosniff`, and the iframe additionally carries
`sandbox="allow-scripts"`. Two independent mechanisms, because this is
agent-written markup and the panel sits inside the authenticated app.

## The annotator

A small script the bridge injects into the served artifact, before `</body>`.
It runs inside the sandboxed frame and its only outward channel is
`postMessage` to the parent:

- Hovering an element while annotation mode is armed outlines it.
- Clicking one sends `{ kind: "element", selector, text, rect }` where
  `selector` is a stable CSS path and `text` is the element's trimmed text,
  truncated.
- Selecting text and releasing sends `{ kind: "selection", text, selector }`.
- The parent replies with `{ mode: "on" | "off" }` to arm or disarm it, and
  `{ scrollTo: selector }` when the human clicks a comment in the list.

The script never reads cookies, never fetches, and has no same-origin access
to anything, because its origin is opaque.

## The panel

Replaces the Lavish tab in the inspector, same position.

- **Session list** when nothing is selected: label, file basename, relative
  time, status dot, comment count. Empty state explains the one command that
  creates one.
- **A session**: the artifact in the frame, filling the drawer. A toolbar with
  the label, an annotate toggle, a comment count, and an end action.
- **Comments** collect in a list under the frame. Each shows its anchor (the
  quoted text or element) and the human's note, and clicking it scrolls the
  frame to that anchor. A comment can be removed before sending.
- **Composer**: a note field, `Send` and `Send & end`. Sending posts the queue
  and clears it; the agent's poll returns immediately.
- Full-screen opens the artifact route in a new tab, which is sandboxed by its
  CSP header even outside the iframe.

## The CLI

`agentbox-review`, installed to `/usr/local/bin` in the image, talking to the
bridge on loopback (`AGENTBOX_REVIEW_URL`, default
`http://127.0.0.1:7800/workbench`).

```
agentbox-review open <file.html> [--label <text>]   # print the URL and key
agentbox-review poll <key|file> [--timeout <sec>]   # block, print JSON, consume
agentbox-review end  <key|file>
agentbox-review list [--json]
```

`open` on an already-open session resumes it and refreshes the stored artifact.
`poll` exits 0 with feedback, 4 when the session was ended by the human (after
delivering any final comments), and 3 on timeout so a caller can retry. Its
JSON is stable:

```json
{
  "key": "a1b2c3",
  "status": "open",
  "comments": [
    { "kind": "element", "anchor": "h2:nth-of-type(2)", "quote": "Rollout plan",
      "note": "split this into two phases" },
    { "kind": "note", "note": "otherwise good" }
  ]
}
```

A Claude Code skill ships beside it so an agent discovers the workflow without
being told, the way the herdr skill does.

## What is removed

- The `lavish-axi` npm install from the image.
- The `lavish` service from compose, its healthcheck, and `agentbox-lavish`.
- The `lavish.<domain>` site from both Caddyfiles.
- `AGENTBOX_LAVISH_DOMAIN`, `AGENTBOX_LAVISH_URL`, `LAVISH_AXI_*`, the
  installer flag, and the bridge's `lavishUrl`/`lavishStateDir`/`lavishPort`.
- `web/bridge/src/lavish.ts`, `LavishPanel.tsx`, and their tests.
- The lavish sections of `docs/workbench.md`, `README.md`, `docs/security.md`,
  `docs/install.md` and `.env.example`, replaced by Review.

An existing install that set the lavish variables keeps them harmlessly in its
`.env`; the update notes say they can be deleted.

## Testing

- Session store: create, resume the same path, end, list ordering, a corrupt
  `session.json` tolerated.
- Feedback queue: post then poll returns and clears; poll with `wait` blocks
  until a post arrives; two pollers do not both consume; ended session returns
  its final comments once then reports ended.
- Artifact route: the annotator is injected, the CSP header is present, path
  traversal in the key is refused.
- CLI: `open` then `poll` round-trip against a real bridge, exit codes for
  timeout and ended.
- Panel: renders the list, posts a comment, `Send & end` ends the session.
- The e2e spec gains a pass: publish an artifact, comment on an element, and
  assert the CLI's poll prints it.
