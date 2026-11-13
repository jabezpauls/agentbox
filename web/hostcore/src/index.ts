// What the bridge in the sandbox and a machine's node share: herdr's socket,
// pane streams and session, the files API (and WebDAV) over a set of roots,
// and the guards in front of them.

export { HerdrError, request, request as herdrRequest, subscribe } from "./herdr/socket.js";
export type { HerdrStreamEvent, Subscription } from "./herdr/socket.js";
export { SessionHub } from "./herdr/session.js";
export { killWithFallback, TerminalStreams } from "./herdr/terminal.js";
export type { Attachment, Killable, Viewer } from "./herdr/terminal.js";
export { isBackpressured, MAX_CHANNELS, muxFrame, PANE_RE, serveTerminalSocket } from "./herdr/terminal-socket.js";
export type { TerminalSocketLike } from "./herdr/terminal-socket.js";
export { heartbeat, HEARTBEAT_MS } from "./ws-heartbeat.js";
export type { Pingable } from "./ws-heartbeat.js";

export { isAllowed, isAllowed as isRpcAllowed } from "./rpc-allowlist.js";
export { pathGuard, pathGuard as guardPath } from "./path-guard.js";

export { FilesService } from "./files/service.js";
export type { FilesOptions } from "./files/service.js";
export { fsError, FilesError, Roots, STATE_DIR, within } from "./files/roots.js";
export type { EntryRef, Located, NewRef, Root, RootConfig, RootMode, RootsOptions, TargetRef } from "./files/roots.js";
export { closeIfBodyUnread, registerFilesRoutes, sendError } from "./files/routes.js";
export { DAV_METHODS, DAV_PREFIX, registerDavRoutes, routableUrl } from "./files/dav/routes.js";
export { LockManager, parseIf } from "./files/dav/locks.js";
export { parseXml, serialize, XML_LIMITS, XmlError } from "./files/dav/xml.js";
export { ListingCache, mapLimit } from "./files/entries.js";
export { decodeName, fsPath } from "./files/names.js";
export { findFd, searchNames } from "./files/search.js";
export { noClobberRename, removeTree } from "./files/tree.js";
export { entryComponent, zipStream } from "./files/zip.js";
