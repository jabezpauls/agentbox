---
name: preview
description: Show the human a running web app — a dev server, a site, a prototype — in their agentbox Preview panel, with live reload. Use whenever they ask to see, preview, run, try or open something you built for the browser, or say "put it in my preview", and before telling them a web app is done.
---

# Preview

The person sees a **Preview** panel beside your terminal, in their browser.
An app you start with `agentbox-preview` appears there — in every tab they
have open, with a note saying you opened it — and updates as you edit (HMR
works). It is private: only they can share it.

## The loop

```bash
agentbox-preview start -- npm run dev          # from the project folder
```

It picks a free port (or take one with `--port`), registers the app, runs the
command in a terminal tab of its own beside you (they can watch it and stop
it), waits until it answers, shows it in their Preview, and prints its URL and
id. Keep working: edits reach the page on their own.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Up and showing | Tell them it is in their Preview |
| 5 | It never answered | Read the output it printed, fix the command or the app, run `start` again |
| 1 | Something else failed | Read the message |

The command runs with `PORT`, `HOST=127.0.0.1` and
`AGENTBOX_BASE_PATH=/a/<id>/` in its environment. The server must listen on
`$PORT` at `127.0.0.1` (or `0.0.0.0`).

Other commands:

```bash
agentbox-preview open 3000          # a server already running on :3000 (or an app id)
agentbox-preview static ./dist      # a folder of files, served for you
agentbox-preview list               # every app, serving or not
agentbox-preview stop <id>          # stop its server and remove it
agentbox-preview start --pin -- npm run preview   # restarted whenever the box starts
```

## Base paths

An app lives at `/a/<id>/` on the box, not at `/`. The box rewrites root
paths in pages, scripts and styles as they pass, so most dev servers work
as they are. It is more reliable to tell the framework its base path:

- **Vite** (React, Vue, Svelte, Solid…): nothing to do — `agentbox-preview`
  adds `--base /a/<id>/ --port $PORT --strictPort --host 127.0.0.1`.
- **Next.js**: `basePath: process.env.AGENTBOX_BASE_PATH?.replace(/\/$/, "")`
  in `next.config.js`; `next dev` reads `PORT`.
- **Astro**: `astro dev --base $AGENTBOX_BASE_PATH --port $PORT --host 127.0.0.1`.
- **SvelteKit**: `kit.paths.base` from `AGENTBOX_BASE_PATH` (without the
  trailing slash) in `svelte.config.js`.
- **Create React App**: `PUBLIC_URL=$AGENTBOX_BASE_PATH`.
- **Plain servers** (Express, Flask, `python3 -m http.server`): listen on
  `$PORT`; use relative URLs where you can.

## When the panel says "This app assumes it runs at /"

The page names places the box could not rewrite — usually an absolute
`http://localhost:<port>` written into the page, or an import map of its own.
Set the framework's base path as above and restart, or build URLs relative to
the page.

## What an app cannot do here

The app runs with an opaque origin: no service workers, no IndexedDB, and
`localStorage` and cookies set from script reset on reload (server-set
cookies work). For full fidelity the person can run
`agentbox forward <port>` on their own machine.

## Do not

- Make an app public, or ask how to: sharing is theirs, from the panel.
- Use claude.ai Artifacts, external hosting or a tunnel (ngrok, cloudflared)
  to show a web app, unless they explicitly ask for that.
- Leave a server running on a port without an app: use `agentbox-preview`
  so they can see it.
