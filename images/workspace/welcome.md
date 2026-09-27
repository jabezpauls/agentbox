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

## Other entry points

- `/vscode/` — this editor
- `/workbench` — the Workbench: every agent at once, with live terminals and
  previews of the servers they start
- `/terminal` — the same herdr session as a full-screen TUI
- `/shell` — a full-screen plain bash shell
- `/monitor` — live CPU, memory and process usage for the sandbox

Start a dev server in any pane and it appears in the Workbench's preview
panel — `python3 -m http.server 3000`, `npm run dev`, anything that listens.

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
