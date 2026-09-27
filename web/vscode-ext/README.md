# agentbox connect

Joins the editor in an agentbox sandbox to the agentbox app, so **Open in
editor** anywhere in the app — a file in Files, a search result, a line an
agent pointed at — opens the file here, at the line.

The extension keeps a socket to the agentbox bridge running beside it in the
sandbox (`ws://127.0.0.1:7800/ws/editor`; the `agentbox.bridgeUrl` setting or
`AGENTBOX_BRIDGE_URL` changes it). The bridge accepts that socket only from
inside the sandbox, never from a browser or through the front door.

It is baked into the agentbox workspace image; there is nothing to configure.
