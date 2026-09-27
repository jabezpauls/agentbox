// The stand-ins of the gate bypass suite, all in plain node containers.
//
//   node harness.mjs
//     The sandbox: takes the network alias `code` and serves an echo server on
//     every port the gate forwards to — the editor (:8080), the three ttyd
//     services (:7681-7683), the bridge (:7800) and its future data plane
//     (:7801). Every request is answered with what arrived (method, path,
//     headers) and logged as a HIT line, so the suite can prove both what
//     crossed the gate and that nothing crossed it at all. A WebSocket
//     handshake is accepted with the same report base64-encoded in `X-Echo`,
//     then closed. A path containing "swa" is answered with
//     `Service-Worker-Allowed: /`, which must never reach a browser.
//
//   node harness.mjs signins <base-url> <n> <password> [Header=value ...]
//     A client: n sign-in attempts at <base-url>, wrong passwords and then the
//     right one last; prints the statuses. `{i}` in a header value becomes the
//     attempt's number, for a forged address that changes every time. Prints
//     "unreachable" when it cannot connect at all.
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
        const headers = { "content-type": "application/json" };
        if (req.url.includes("swa")) headers["service-worker-allowed"] = "/";
        res.writeHead(200, headers);
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

async function signins(base, n, password, headerArgs) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const headers = { "content-type": "application/json", origin: base };
    for (const arg of headerArgs) {
      const eq = arg.indexOf("=");
      headers[arg.slice(0, eq)] = arg.slice(eq + 1).replaceAll("{i}", String(i + 1));
    }
    try {
      const res = await fetch(`${base}/_gate/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username: "ci", password: i === n - 1 ? password : "wrong-password" }),
        signal: AbortSignal.timeout(5_000),
      });
      codes.push(res.status);
    } catch {
      console.log("unreachable");
      return;
    }
  }
  console.log(codes.join(" "));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "signins") {
  const [base, n, password, ...headers] = rest;
  await signins(base, Number(n), password, headers);
} else {
  serve();
}
