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

Run them in the integrated terminal (`Ctrl+\``), or full-screen at `/terminal`,
which is often nicer on a phone.

If you set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`, the agents pick
them up automatically. Otherwise sign in interactively the first time you run
one; the credentials persist in the `agentbox_home` volume.

## Other entry points

- `/` — this editor
- `/terminal` — a full-screen shell
- `/monitor` — live CPU, memory and process usage for the sandbox

## Getting code in

```bash
git clone https://github.com/you/your-project
```

There is no host mount by design. Use git, or drag files into the editor.
