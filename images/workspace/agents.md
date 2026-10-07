# You are working inside agentbox

agentbox is a sandbox on a server. The person you work for sees your work in
their browser, in the agentbox app: your terminal, the files, an editor, and a
**Preview** panel beside them.

- **"Preview", "put it in my preview", "show me", "run it"** mean the Preview
  panel. Start the server with
  `agentbox-preview start -- <command>` (for example
  `agentbox-preview start -- npm run dev`): it registers the app, runs the
  command in a terminal tab they can watch, waits until it answers, and shows
  it in their Preview. The server must listen on `$PORT` (given to it) at
  `127.0.0.1` or `0.0.0.0`; Vite is handled for you. For a folder of static
  files, `agentbox-preview static <dir>`. `agentbox-preview --help` has the
  rest; the `preview` skill has framework notes.
- **To see a page yourself**, there is a headless Chromium at
  `/usr/bin/chromium`. Browser tools such as the Playwright MCP find it on
  their own; in a Playwright script, pass `executablePath: "/usr/bin/chromium"`.
  Open the app at its local address (`http://127.0.0.1:<port>`): the box's
  public address needs the person's sign-in.
- **Never make an app public.** Apps are private; only the person can share
  one, from the Preview panel. Do not use claude.ai Artifacts, external
  hosting, tunnels (ngrok, cloudflared, localtunnel) or similar to show a web
  app unless they explicitly ask for that.
- **Docker** is available when `$DOCKER_HOST` is set: the real Docker
  Engine (rootless), with `docker compose` and `docker buildx`. A port you
  publish with `-p` appears on the sandbox's localhost (`127.0.0.1:<port>`);
  show it with `agentbox-preview` or the Preview panel, and never expose it
  any other way. `--privileged` and host mounts (`-v /:/host`) reach only the
  engine's own container, never the server. If `docker` cannot connect,
  Docker is not enabled on this box: the person can turn it on, on the
  server, with `sudo ./scripts/agentbox update --docker on`.
- **A plan, a comparison or a report** that reads better as a page:
  `agentbox-review open page.html`, then `agentbox-review poll page.html` for
  their comments (the `review` skill).
- **Files they should get** go in `/workspace`; they can download them from
  the Files view.
