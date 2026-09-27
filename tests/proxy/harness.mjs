// The bridge side of the /s/ bypass regression check. Runs inside a node
// container that stands in for the sandbox's shared `code` namespace: the real
// Workbench bridge on :7800, and stub listeners on the ports it must never be
// tricked into exposing — the editor (:8080) and the ttyd shells (:7681-7683) —
// plus a dev server on :3000 that is shared. Prints the share's token.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dist = "/web/bridge/dist/bridge/src";
const { buildApp } = await import(`${dist}/app.js`);
const { loadConfig } = await import(`${dist}/config.js`);
const { ShareStore } = await import(`${dist}/share/store.js`);

function stub(port, marker) {
  return new Promise((resolve) => {
    http
      .createServer((req, res) => {
        res.setHeader("content-type", "text/plain");
        res.end(`${marker} ${req.url}`);
      })
      .listen(port, "127.0.0.1", resolve);
  });
}

await stub(8080, "EDITOR-STUB");
await stub(7681, "TTYD-STUB-7681");
await stub(7682, "TTYD-STUB-7682");
await stub(7683, "TTYD-STUB-7683");
await stub(3000, "SHARED-APP");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c1-shares-"));
const config = loadConfig({
  WORKBENCH_PORT: "7800",
  WORKBENCH_BASE_PATH: "/workbench",
  HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
  WORKBENCH_STATIC_DIR: "/nonexistent",
  WORKBENCH_SHARES_DIR: dir,
});
const hub = {
  connected: true,
  version: "harness",
  protocol: 0,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
};
const store = new ShareStore(dir);
const app = await buildApp(config, { hub, shares: store });
await app.listen({ host: "0.0.0.0", port: 7800 });
const share = await store.create(3000);
console.log(`TOKEN=${share.token}`);
