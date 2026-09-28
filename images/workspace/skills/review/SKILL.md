---
name: review
description: Show the human an HTML page instead of describing it, and get their comments back anchored to the part they mean. Use when about to hand over a plan, a comparison, a report, a diagram, a table, or anything else that is easier to look at than to read as prose — and whenever you want a decision on something you have laid out.
---

# Review

Some answers are a place in a document, not a paragraph. A plan the person
wants reordered, a comparison table with one row that is wrong, a diagram with
a missing arrow — prose is a poor medium for saying it, and a worse one for
hearing the reply.

`agentbox-review` puts the page in front of them inside Workbench. They click
the heading or select the phrase they mean, write what they think, and press
Send. Your blocking `poll` returns with their comments, each carrying the
element or the quote it refers to.

## The loop

```bash
agentbox-review open plan.html --label "Rollout plan"   # prints a URL and a key
agentbox-review poll plan.html                          # blocks until they answer
```

`open` prints the link to hand the person, and the key. It is safe to run
again on the same file: the session resumes and the stored copy is refreshed,
so edit and re-open rather than starting a second session.

`poll` blocks. Its stdout is exactly this, and nothing else:

```json
{
  "key": "a1b2c3d4",
  "status": "open",
  "comments": [
    { "kind": "element", "anchor": "body > h2:nth-of-type(2)", "quote": "Rollout plan",
      "note": "split this into two phases" },
    { "kind": "note", "note": "otherwise good" }
  ]
}
```

Its exit code is how you know what happened, without parsing anything:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Comments arrived | Act on them, then `open` the revised page and poll again |
| 3 | The wait elapsed | Nothing was said yet; poll again, or get on with something else |
| 4 | The session ended | These are the last comments; do not poll it again |
| 2 | No such session | Check the key, or `open` first |

`agentbox-review end plan.html` closes a session from your side.
`agentbox-review list` shows what is outstanding.

## Writing the page

A plain self-contained HTML file. Inline the CSS — the page is served with an
opaque origin and no network access, so an external stylesheet, font or script
will not load. Scripts of your own do run.

Give it real structure: headings, sections, lists, tables. The person anchors
their comments to elements, so a page made of well-separated blocks is one
they can be precise about; a single wall of text gives them nothing to point
at. Keep it readable in both a light and a dark browser theme, or state your
own colours explicitly.

## When to reach for it

- A plan or a proposal you want signed off before you start.
- A comparison of options where the decision is the point.
- A report, an audit, a summary of what you found across many files.
- A diagram, a table, a before/after — anything spatial.

Do not use it for a one-line answer, for something the person asked to see in
the terminal, or as a way to avoid saying something plainly.

A review page is a document. A running web app — a dev server, a prototype,
anything with live reload — goes in their Preview instead: see the `preview`
skill (`agentbox-preview start -- npm run dev`).
