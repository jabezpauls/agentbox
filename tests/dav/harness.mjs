// The bridge side of the WebDAV client check: the real bridge build serving
// /api/dav over two throwaway roots, with no herdr behind it (WebDAV does not
// need one). Prints READY once it listens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../../web/bridge/dist/bridge/src");
const { buildApp } = await import(`${dist}/app.js`);
const { loadConfig } = await import(`${dist}/config.js`);

const port = Number(process.argv[2] ?? 7899);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dav-clients-"));
for (const d of ["workspace", "home"]) fs.mkdirSync(path.join(dir, d));
const config = loadConfig({
  WORKBENCH_PORT: String(port),
  HERDR_SOCKET_PATH: path.join(dir, "no-herdr.sock"),
  WORKBENCH_STATIC_DIR: path.join(dir, "no-static"),
  WORKBENCH_WORKSPACE_ROOT: path.join(dir, "workspace"),
  WORKBENCH_HOME_ROOT: path.join(dir, "home"),
  WORKBENCH_REVIEW_DIR: path.join(dir, "review"),
  WORKBENCH_SHARES_DIR: path.join(dir, "shares"),
  HOME: path.join(dir, "home"),
});
const hub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
};
const app = await buildApp(config, { hub });
await app.listen({ host: "127.0.0.1", port });
const stop = () => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log("READY");
