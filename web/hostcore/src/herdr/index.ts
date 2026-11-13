// herdr for a host: its socket, the session hub, pane streams and the terminal
// socket protocol, the RPC allowlist. Node built-ins only, so a machine's node
// can bundle it without the files API.
export { HerdrError, request, subscribe } from "./socket.js";
export type { HerdrStreamEvent, Subscription } from "./socket.js";
export { SessionHub } from "./session.js";
export { TerminalStreams } from "./terminal.js";
export type { Attachment, Viewer } from "./terminal.js";
export { PANE_RE, serveTerminalSocket } from "./terminal-socket.js";
export type { TerminalSocketLike } from "./terminal-socket.js";
export { isAllowed } from "../rpc-allowlist.js";
export { heartbeat } from "../ws-heartbeat.js";
