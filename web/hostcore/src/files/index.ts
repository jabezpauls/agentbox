// The files API for a machine's node: the service over a set of roots, and
// its routes over plain node:http. Neither Fastify nor the zip library is
// reached from here, so the node's bundle carries neither.

export { FilesService } from "./service.js";
export type { FilesOptions } from "./service.js";
export { FilesError, Roots, within } from "./roots.js";
export type { RootConfig, RootMode, RootsOptions } from "./roots.js";
export { serveFiles } from "./http.js";
