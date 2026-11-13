# Machines, phase 0: spike findings

Status: done, November 2026. Answers the unknowns in phase 0 of
`2026-11-13-machines-plan.md`; the spec changes are folded into
`2026-11-13-machines-design.md`. The scratch code (a throwaway
`windows-latest` workflow on `machines/p0-spike`, runs 43461177096 and
43462622553, and Linux containers) is not kept.

Left for the owner, by hand, later: how long a revoked setup token keeps
working at claude.ai (question 3 of the plan), Smart App Control on a real
Windows 11 machine (question 6), and Claude Code's first run on Windows
(question 2's Windows half; the Linux half is below).

## 1. herdr 0.9.3 on Windows

**Tried.** On `windows-latest`: downloaded the release zip, hashed and listed
it, started `herdr server` hidden, listed `\\.\pipe\`, sent NDJSON from Node
`net.connect`, created a workspace, and ran `herdr terminal session control
<pane> --takeover` over stdio, as `web/bridge/src/herdr/terminal.ts` does.

**Result: it works as on Linux.**

- `herdr-windows-x86_64.zip`, 9 846 312 bytes, SHA-256
  `c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795`
  (the same digest GitHub shows for the asset). Contents:

  | File | Bytes | SHA-256 |
  | --- | --- | --- |
  | `herdr.exe` | 26 306 048 | `d12a5a55f5b3668dba8366eda8580075bf0b78201b0112df6b7234fa005a2b0d` |
  | `conpty/conpty.dll` | 109 920 | `39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8` |
  | `conpty/herdr-conpty.json` | 450 | `c8f499ad82c568e737d6bc7d0b583e3785d2f43af3d2c0cebb856076690533f5` |
  | `conpty/x64/OpenConsole.exe` | 1 066 296 | `b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160` |
  | `conpty/arm64/OpenConsole.exe` | 1 120 056 | `ed7622fd0d3bedc9ab9f122f5e58edf0def9e7999224f52dd395ba9f54edbe09` |
  | `THIRD-PARTY-NOTICES/…` (2 files) | | |

  `herdr.exe` is not Authenticode-signed (`NotSigned`).
- **Pipe naming.** The named pipe is `\\.\pipe\` followed by the socket path,
  verbatim: with `HERDR_SOCKET_PATH=D:\a\_temp\node\herdr.sock` the server
  makes `\\.\pipe\D:\a\_temp\node\herdr.sock` and
  `\\.\pipe\D:\a\_temp\node\herdr-client.sock`, and writes a 24-byte marker
  file at each path (`<pid>:<nanos>`). `net.connect("\\\\.\\pipe\\" + path)`
  answers `ping` (`version 0.9.3, protocol 22`); `net.connect(path)` fails
  with `ENOTSOCK`. Without the variable the socket is
  `%APPDATA%\herdr\herdr.sock` (Roaming); config and logs are in
  `%APPDATA%\herdr`, agent-detection state in `%LOCALAPPDATA%\herdr`.
- **RPC.** `ping`, `session.snapshot`, `workspace.create` (root pane
  `w1:p1`, shell `pwsh`), `events.subscribe` (`pane.scroll_changed`) and
  `pane.get` all answer as on Linux. Paths come back with backslashes
  (`D:\a\agentbox\agentbox\`).
- **Terminal streaming.** `terminal session control` over stdio streamed
  `terminal.frame` lines (`encoding: ansi`, first `full: true` at 100×30,
  then diffs showing the `PS D:\…>` prompt); `terminal.input` reached the
  shell (the echoed marker came back in a frame), `terminal.resize` was
  accepted, `terminal.release` ended it with `terminal.closed` `detached`
  and exit 0.
- **The pipe's DACL is the Windows default**, not owner-only:
  `D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)` (Everyone and
  Anonymous read; SYSTEM and the owner, here Administrators, full). herdr has
  an owner-only listener in its code (`D:P(A;;GA;;;SY)(A;;GA;;;OW)`) but uses
  it only for its client endpoints, not the API socket. A pipe made by Node's
  `net.createServer` has exactly the same default DACL (measured). Pipe names
  are global, not under the folder's ACL: another local user cannot write
  requests (read only), but could create a pipe of that name first.
- A second herdr server on another socket path came up with the first one's
  workspace already in it (its new one was `w2`): the socket path does not
  separate herdr's saved session state, the session does.

**Spec change.** Pin all five files above, not just the zip, since the node
installs from the zip's contents. The node's control channel cannot get an
owner-only ACL from pure Node: requests on it carry a random secret read from
a file in the node folder. On a Windows machine with other local users,
herdr's pipe is squattable; the node uses a fresh random component in
`HERDR_SOCKET_PATH` per herdr start and checks herdr answers `ping` with the
pinned version, and the docs call shared Windows machines unsupported in v1.
The node's herdr runs in a herdr session of its own (`HERDR_SESSION`), so it
never restores or shows the owner's own herdr workspaces; the Windows phase
checks that `HERDR_SOCKET_PATH` still wins over the session's default path.

## 2. Claude Code first run (Linux)

**Tried.** In `debian:bookworm-slim` containers (non-root, no `DISPLAY`,
`BROWSER=/bin/true`, never on the host): Claude Code 2.1.311, the current
`stable` (`https://downloads.claude.ai/claude-code-releases/stable` answers
`2.1.311`; `latest` answers `2.1.323`). Manifest at
`…/claude-code-releases/2.1.311/manifest.json`; binary at
`…/2.1.311/linux-x64/claude`, 293 776 752 bytes, SHA-256
`86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada`, equal to
the manifest's `checksum`. The manifest says
`"manifestSignatureEnforcement": "flag"` and a `manifest.json.sig` exists
next to it. Run in a pty (`script -qfec`) with `CLAUDE_CONFIG_DIR` empty or
seeded, `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake`, `DISABLE_UPDATES=1`,
`--append-system-prompt-file /tmp/x.md`; typed `hello`, Enter.

**Result.**

| Seed | First screen |
| --- | --- |
| none | theme picker, then "Select login method" (subscription / Console / 3rd-party), although the token is set |
| `{"hasCompletedOnboarding": true}` in `$HOME/.claude.json` | the same: with `CLAUDE_CONFIG_DIR` set, that file is not read |
| `{"hasCompletedOnboarding": true}` in `$CLAUDE_CONFIG_DIR/.claude.json` | no theme, no login; but the **folder trust** dialog ("Is this a project you created or one you trust?", default "No, exit") — the typed Enter exited |
| plus `"projects": {"<folder>": {"hasTrustDialogAccepted": true}}` | straight to the prompt; `hello` gave "API Error: 401 OAuth access token is invalid · Please run /login" (expected with the fake token) |

- Trust is inherited: trust on `/tmp`, or on `$HOME`, covers a session
  started in `/tmp/proj` or `$HOME/code/proj`.
- With a bad token the banner also shows "Remote managed settings failed to
  load (401)"; harmless.
- Outside `CLAUDE_CONFIG_DIR` it wrote one file:
  `~/.local/share/applications/claude-code-url-handler.desktop` (its
  `claude-cli://` handler; on Windows, `HKCU\Software\Classes`). The setting
  `"disableDeepLinkRegistration": "disable"` in
  `$CLAUDE_CONFIG_DIR/settings.json` stops it (measured: no file written).
- No browser was launched in any run.

**Spec change.** The node seeds two files in `<node folder>/claude/`:
`.claude.json` = `{"hasCompletedOnboarding": true, "projects": {"<home>":
{"hasTrustDialogAccepted": true}}}` (home trusted as the agents run as the
owner with full access anyway; each allowed folder is under it, and drive
roots are added on Windows for folders outside home), and `settings.json` =
`{"disableDeepLinkRegistration": "disable"}`. Seeding only when the file is
absent; Claude Code rewrites `.claude.json` itself. Pin 2.1.311 (≥ 2.1.225);
verify the manifest's `.sig` once its key is published, until then the node's
own signed manifest carries the digest.

## 3. Single-executable application

**Tried.** `web/cli` bundled by esbuild as CommonJS (`format: "cjs"`,
`node22` target, `ws` included, its native add-ons external), a SEA blob from
`node --experimental-sea-config` (`useCodeCache: false`), injected into a copy
of `node` with `postject` 1.0.0-alpha.6. Linux built in `node:22-bookworm` and
`node:24-bookworm` and run in `debian:bookworm-slim` (no Node in it); Windows
built and run on `windows-latest`. A probe mode ran a `ws` server and client
over loopback, PBKDF2-SHA256 at 600 000 iterations, a `net` server and client
(Unix socket / named pipe), and on Windows a `ping` to herdr's pipe.

**Result.** Everything works inside the SEA (`sea.isSea()` true; `ws`
echoed; PBKDF2 correct; `net` on a Unix socket, on a named pipe, and to
herdr's pipe).

| | Node | Size | `--version`, warm cold-start | PBKDF2 600k |
| --- | --- | --- | --- | --- |
| linux-x64 | 22.23.5 | 125 242 560 B (119.4 MiB; gzip 39.8 MiB, xz 27.3 MiB) | 28–34 ms | 59 ms |
| linux-x64 | 24.22.3 | 127 274 176 B (121.4 MiB; gzip 41.3 MiB, xz 28.4 MiB) | 31–41 ms | 58 ms |
| win-x64 | 22.23.4 | 87 476 224 B (83.4 MiB) | 74–78 ms | 118 ms |
| win-x64 | 24.22.2 | 94 364 672 B (90.0 MiB) | 77–93 ms (first 124) | 124 ms |

The bundle itself is 309 KiB. Linux times are a desktop, Windows times a CI
runner (`node --version` there: 20 ms).

Findings that change the build:

- `web/cli/src/cli.ts` uses top-level `await`, which CommonJS does not
  allow. The SEA needs its own entry (the same code in an async function).
- `postject` on Windows warns "The signature seems corrupted!": `node.exe` is
  signed by the OpenJS Foundation and injection breaks it, so the SEA is
  unsigned. Signing, if chosen, happens after injection (and after the
  subsystem patch below), with the signature stripped first.
- Each platform's SEA is built on that platform (or with that platform's
  `node` binary) in CI.

**Spec change.** Build the SEA on **Node 24** (LTS to April 2028; 22 ends
April 2027): about the same size and speed. Sizes are about 120 MiB on Linux
and 90 MiB on Windows, about 40 MiB to download gzipped. A dedicated CJS entry.

## 4. Hidden start on Windows

**Tried.** A copy of the win-x64 SEA with the PE optional header's
`Subsystem` field (offset 68 into the optional header; file offset `0x194`
in this `node.exe`, PE32+) changed from 3 (console) to 2 (Windows GUI), one
two-byte write. Launched both copies with `Start-Process`; each wrote a file,
spawned PowerShell with and without `windowsHide` reporting
`GetConsoleWindow()` and `IsWindowVisible`, listened on a pipe, and the GUI
copy also started `herdr server` (`detached`, `windowsHide`) and created a
workspace through it.

**Result.**

- The GUI copy runs normally (Node, the SEA blob, `ws`, PBKDF2, pipes) and
  has **no console**: no `conhost.exe` child (the console copy had one), no
  window, and the set of processes with a window was unchanged (`explorer`,
  `WindowsTerminal`) with herdr and two `pwsh` panes running under it.
- A child spawned with `windowsHide: true` gets no console window
  (`GetConsoleWindow() = 0`); without it the same child gets a **visible
  console window** (`visible=True`), from either copy. So `windowsHide` on
  every spawn is required, not hygiene.
- herdr started from the GUI copy with `windowsHide` has no `conhost.exe` of
  its own; its panes run under its `OpenConsole.exe` (ConPTY), with no window.
- Caveats: in the GUI copy `process.stdout` is not a TTY (a discard stream
  when nothing is attached), and with stdout redirected to a pipe it threw an
  unhandled `EPIPE` at exit; a console shell does not wait for it (returned in
  3 ms). So it is useful only to start things, never for commands a person
  runs. Patching changes the file's digest, and must come before signing.

**Spec change.** No separate stub program: the release ships a second
Windows asset, `agentbox-node.exe`, the same SEA with `Subsystem = 2`
(made and digested in CI, listed in the signed manifest). The Run entry
starts `agentbox-node.exe node supervise`, which spawns the console
`agentbox.exe node run` with `windowsHide` (so it has a console, but no
window, and its output goes to the log) and restarts it with backoff. The
logon behaviour from `HKCU\…\Run` is not tested here (CI has no logon), only
the launch itself: confirm by hand on the owner's Windows machine.

## Decisions for the owner

1. Node 24 for the SEA (recommended above).
2. Windows signing: still waits on the Smart App Control test by hand. What
   is known: the SEA and herdr are both unsigned as shipped, and signing would
   cover `agentbox.exe`, `agentbox-node.exe`, and (re-signed by us, or
   accepted unsigned) herdr's `herdr.exe`, `conpty.dll` and `OpenConsole.exe`.
3. Shared Windows machines (other local users): unsupported in v1, as above,
   or wait for herdr to put its API pipe behind its owner-only DACL (an
   upstream change to ask for).
