# agentbox CLI

The command line for [agentbox](https://github.com/jabezpauls/agentbox), a
sandbox on your own server where coding agents keep working after you close
the laptop. It signs in to your box, attaches to its agents from your own
terminal, moves files both ways, and mounts the workspace as a folder.

You need a box first. See
[installing agentbox](https://github.com/jabezpauls/agentbox/blob/main/docs/install.md).

## Install

Node.js 20 or newer:

```bash
npm i -g @jabezpauls/agentbox
agentbox login https://code.example.com
```

`login` shows a code and opens your box in the browser, where you approve this
machine. No password is typed into the terminal.

Your box also serves this same CLI, matched to its version:

```bash
curl -fsSL https://code.example.com/cli/install | sh
```

## Use

```bash
agentbox status              # the box, its agents and its apps
agentbox attach              # the agents, in this terminal
agentbox shell               # a shell in the sandbox
agentbox files put notes.md  # copy into the workspace
agentbox files get report.pdf  # and back out
agentbox mount ~/box         # the workspace as a folder
agentbox --help
```

Every command is described in
[docs/cli.md](https://github.com/jabezpauls/agentbox/blob/main/docs/cli.md).

## Versions

The CLI's version follows agentbox's releases. When your box runs a different
version, the CLI says so. Update with `npm i -g @jabezpauls/agentbox@<version>`.

MIT licensed.
