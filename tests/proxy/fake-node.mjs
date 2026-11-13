// A machine's node as a compromised machine might play it, for the gate
// bypass suite: it holds a link like a real node (through the proxy, with its
// node token from $NODE_TOKEN), and answers every stream the gate opens with
// what the gate must never pass on to the machines origin as it is — an HTML
// page, a cookie for the machines origin, a redirect.
//
// Runs in the gate's own image, for its `ws` and the link's codec:
//   node /fake-node.mjs <ws://proxy:port> <box host>
import http from "node:http";
import { WebSocket } from "/app/node_modules/ws/wrapper.mjs";
import { decodeFrame, encodeControl, FrameType, StreamTable } from "/app/dist/link/index.js";

const [url, host] = process.argv.slice(2);
const policy = { terminals: true, files: [], ports: false, share: false, updates: "off", presenceHours: 1, paused: false, problem: null };

const server = http.createServer((req, res) => {
  if (req.url === "/html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><script>alert('machine')</script>");
  }
  if (req.url === "/cookie") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "set-cookie": "__Host-agentbox-machines=planted; Path=/; Secure; HttpOnly",
      "access-control-allow-origin": "*",
    });
    return res.end("cookie-body");
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "https://evil.example/" });
    return res.end();
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});

const ws = new WebSocket(`${url}/_gate/node`, { headers: { host, authorization: `Bearer ${process.env.NODE_TOKEN}` } });
const streams = new StreamTable((f) => ws.send(f));
ws.on("open", () => {
  ws.send(
    encodeControl({
      type: "hello",
      protocol: 1,
      version: "0.0.0-bypass",
      nonce: "B".repeat(43),
      platform: "linux",
      arch: "x64",
      hostname: "bypass",
      cpu: { model: "none", cores: 1 },
      ramBytes: 1,
      disks: [],
      gpus: [],
      docker: false,
      claude: null,
      policy,
    }),
  );
});
ws.on("message", (data) => {
  const f = decodeFrame(data);
  if (f.type === FrameType.control) return console.log(`control ${f.payload.toString("utf8").slice(0, 200)}`);
  if (f.type === FrameType.open) return server.emit("connection", streams.open(f.stream));
  streams.receive(f);
});
ws.on("unexpected-response", (_req, res) => {
  console.log(`refused ${res.statusCode}`);
  process.exit(1);
});
ws.on("close", (code) => {
  console.log(`closed ${code}`);
  process.exit(0);
});
