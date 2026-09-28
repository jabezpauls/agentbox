#!/usr/bin/env node
// Two small apps for the fidelity suite, served on $PORT at 127.0.0.1, both
// written for `/` the way apps usually are.
//
//   node tiny-apps.mjs storage   a page that uses localStorage and document.cookie
//   node tiny-apps.mjs login     an app with its own cookie sign-in and a live
//                                event stream for signed-in visitors
//   node tiny-apps.mjs sprite    icons from an SVG sprite in another file
//                                (<use href="/icons.svg#…">), as create-vite's
//                                React template has them
import { randomBytes } from "node:crypto";
import http from "node:http";

const mode = process.argv[2];
const port = Number(process.env.PORT);

const STORAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>storage</title></head>
<body><p id="result">running</p>
<script>
  try {
    localStorage.setItem("k", "v");
    sessionStorage.setItem("s", "w");
    document.cookie = "c=1; path=/";
    document.getElementById("result").textContent =
      "storage ok " + localStorage.getItem("k") + " " + sessionStorage.getItem("s") + " " + document.cookie;
  } catch (e) {
    document.getElementById("result").textContent = "storage crashed: " + e.name;
  }
</script></body></html>`;

const SPRITE = `<!doctype html>
<html><head><meta charset="utf-8"><title>sprite</title></head>
<body>
<svg width="20" height="20"><use id="static" href="/icons.svg#dot"></use></svg>
<svg width="20" height="20" id="later"></svg>
<script>
  // As React renders it: the element made in script, its href set as an attribute.
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "/icons.svg#square");
  use.id = "scripted";
  document.getElementById("later").appendChild(use);
</script></body></html>`;

const ICONS = `<svg xmlns="http://www.w3.org/2000/svg">
<symbol id="dot" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></symbol>
<symbol id="square" viewBox="0 0 20 20"><rect width="16" height="16" x="2" y="2"/></symbol>
</svg>`;

const sessions = new Set();

function signedIn(req) {
  const m = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? "");
  return m !== null && sessions.has(m[1]);
}

const LOGIN_FORM = `<!doctype html>
<html><head><meta charset="utf-8"><title>login app</title></head>
<body><h1>Please sign in</h1>
<form method="post" action="/login"><input name="user" aria-label="User" value="ada"><button type="submit">Sign in</button></form>
</body></html>`;

const WELCOME = `<!doctype html>
<html><head><meta charset="utf-8"><title>login app</title></head>
<body><h1 id="who">Signed in as ada</h1><p>Tick: <span id="tick">none</span></p><p id="stream">connecting</p>
<script>
  const es = new EventSource("/events");
  es.onopen = () => { document.getElementById("stream").textContent = "streaming"; };
  es.onmessage = (e) => { document.getElementById("tick").textContent = e.data; };
  es.onerror = () => { document.getElementById("stream").textContent = "stream lost"; };
</script></body></html>`;

const server = http.createServer((req, res) => {
  const html = (body, status = 200) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };
  const url = new URL(req.url ?? "/", "http://x");
  if (mode === "storage") return html(STORAGE);
  if (mode === "sprite") {
    if (url.pathname !== "/icons.svg") return html(SPRITE);
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end(ICONS);
  }

  if (url.pathname === "/login" && req.method === "POST") {
    req.resume();
    const sid = randomBytes(8).toString("hex");
    sessions.add(sid);
    res.writeHead(303, { location: "/", "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end();
  }
  if (url.pathname === "/events") {
    if (!signedIn(req)) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    let n = 0;
    const tick = () => res.write(`data: ${++n}\n\n`);
    tick();
    const timer = setInterval(tick, 300);
    res.on("close", () => clearInterval(timer));
    return;
  }
  return html(signedIn(req) ? WELCOME : LOGIN_FORM);
});
server.listen(port, "127.0.0.1", () => console.log(`${mode} app on ${port}`));
