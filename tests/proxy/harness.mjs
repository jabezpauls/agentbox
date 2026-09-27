// The sandbox side of the gate bypass suite. Runs in a plain node container
// that takes the network alias `code`, standing in for the sandbox's shared
// namespace: an echo server on every port the gate forwards to — the editor
// (:8080), the three ttyd services (:7681-7683), the bridge (:7800) and its
// future data plane (:7801).
//
// Every request is answered with what arrived — method, path, headers — and
// logged as a HIT line, so the suite can prove both what crossed the gate and
// that nothing crossed it at all. A WebSocket handshake is accepted with the
// same report base64-encoded in an `X-Echo` header, then closed.
//
//   node harness.mjs                     serve
//   node harness.mjs direct <n> <pass>   sign in to gate:7900 directly, as a
//                                        process in the sandbox would, with a
//                                        forged X-Forwarded-For each time
//   node harness.mjs proxied <n> <pass>  the same through the proxy, as a
//                                        second client with its own address
import crypto from "node:crypto";
import http from "node:http";

const PORTS = { 8080: "editor", 7681: "terminal", 7682: "monitor", 7683: "shell", 7800: "bridge", 7801: "data-plane" };

function report(port, req) {
  return { echo: PORTS[port], port: Number(port), method: req.method, url: req.url, headers: req.headers };
}

function serve() {
  for (const port of Object.keys(PORTS)) {
    const server = http.createServer((req, res) => {
      console.log(`HIT ${port} ${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(report(port, req)));
      });
    });
    server.on("upgrade", (req, socket) => {
      console.log(`HIT ${port} UPGRADE ${req.url}`);
      const accept = crypto
        .createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      const echo = Buffer.from(JSON.stringify(report(port, req))).toString("base64");
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\nX-Echo: ${echo}\r\n\r\n`,
      );
    });
    server.listen(Number(port), "0.0.0.0");
  }
  console.log("READY");
}

async function signIns(base, n, password) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}/_gate/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base,
        "x-forwarded-for": `198.51.100.${i + 1}`,
        "cf-connecting-ip": `198.51.100.${i + 1}`,
      },
      body: JSON.stringify({ username: "ci", password: i === n - 1 ? password : "wrong-password" }),
    });
    codes.push(res.status);
  }
  console.log(codes.join(" "));
}

const [mode, n, password] = process.argv.slice(2);
if (mode === "direct") await signIns("http://gate:7900", Number(n), password);
else if (mode === "proxied") await signIns("http://proxy:8080", Number(n), password);
else serve();
