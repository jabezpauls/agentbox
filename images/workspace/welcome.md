# Your sandbox

This is a container. It has no access to the host filesystem, no Docker socket,
and no privileges. Everything you keep here lives on the `agentbox_workspace`
volume and survives restarts and updates.

## Coding agents

Both CLIs are installed and on your `PATH`:

```bash
claude      # Claude Code
codex       # OpenAI Codex
```

Run them in the integrated terminal (`Ctrl+\``), or in a pane at `/workbench`,
or full-screen at `/terminal`. The last two are both clients of
[herdr](https://github.com/herdrdev/herdr), a background agent multiplexer: it
keeps your agent panes alive independent of the browser tab, so the same
session is waiting for you in either view.

If you set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`, the agents pick
them up automatically. Otherwise sign in interactively the first time you run
one; the credentials persist in the `agentbox_home` volume.

Agents are told how this box works every time they start: that "preview"
means the Preview panel, how to put an app there, and that only you can make
one public.

## Other entry points

- `/vscode/` — this editor
- `/workbench` — the Workbench: every agent at once, with live terminals, and
  the Preview and Review panels beside them
- `/terminal` — the same herdr session as a full-screen TUI
- `/shell` — a full-screen plain bash shell
- `/monitor` — live CPU, memory and process usage for the sandbox

## Seeing what you build

Ask an agent to put something in your preview, or do it yourself from any
pane:

```bash
agentbox-preview start -- npm run dev
```

The dev server runs in a terminal tab you can watch, and it opens in the
**Preview** panel of every tab you have open, with live reload. Each app has
its own address on your box, `/a/<id>/`, which only you can open — until you
press **Share** and choose "anyone with the link" (or a passcode) and for how
long; **Stop sharing** makes it private again. A server you started some
other way shows up in the panel under *Also listening*; choose it to make it
an app.

## Showing you something

When an agent has a plan, a comparison or a report that reads better as a page
than as prose, it publishes one and waits for your answer:

```bash
agentbox-review open plan.html --label "Rollout plan"
agentbox-review poll plan.html      # blocks until you press Send
```

It appears in the Workbench's **Review** panel. Click the part you mean, say
what you think, and send — the agent's command returns with your comments
anchored to what they refer to.

## Getting code in

```bash
git clone https://github.com/you/your-project
```

There is no host mount by design. Use git, or drag files into the editor.
