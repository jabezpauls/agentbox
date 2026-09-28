#!/usr/bin/env node
// Put a small, realistic project into a workspace root, for looking at the
// app and for the docs' screenshots:
//
//   node e2e/tools/seed.mjs <workspace root>
//
// A git repository with a commit and a couple of uncommitted changes, so
// Home's cards and Files' marks have something to say.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function png(width, height, rgba = [37, 99, 235, 255]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgba).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function seed(root) {
  const demo = path.join(root, "goofy-app");
  const write = (rel, content) => {
    const file = path.join(demo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(
    "README.md",
    "# goofy-app\n\nA small React page an agent built to show off the preview.\n\n## Run it\n\n```sh\nnpm install\nnpm run dev\n```\n\n| Step | Who |\n| --- | --- |\n| Scaffold | claude |\n| Review | you |\n\n![logo](public/logo.png)\n",
  );
  write("package.json", JSON.stringify({ name: "goofy-app", private: true, type: "module", scripts: { dev: "vite", build: "vite build" } }, null, 2) + "\n");
  write("index.html", '<!doctype html>\n<html lang="en">\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n');
  write("src/main.tsx", 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
  write("src/App.tsx", 'export function App() {\n  return <h1>Hello from goofy-app</h1>;\n}\n');
  write("src/styles.css", "body {\n  font-family: system-ui;\n}\n");
  write("docs/plan.md", "# Plan\n\n1. Scaffold\n2. Preview\n3. Share\n");
  write(".gitignore", "node_modules\ndist\n");
  fs.mkdirSync(path.join(demo, "public"), { recursive: true });
  fs.writeFileSync(path.join(demo, "public/logo.png"), png(96, 96));
  const git = (...args) => execFileSync("git", args, { cwd: demo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "agentbox", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "agentbox", GIT_COMMITTER_EMAIL: "demo@example.com" } });
  try {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "Scaffold goofy-app");
    fs.appendFileSync(path.join(demo, "src/App.tsx"), "// TODO: make it goofier\n");
    fs.writeFileSync(path.join(demo, "src/Button.tsx"), "export const Button = () => <button>Click</button>;\n");
  } catch {
    // No git here: the project is still a folder of files.
  }
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes/ideas.txt"), "Things to try next.\n");
  return demo;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: seed.mjs <workspace root>");
    process.exit(2);
  }
  console.log(seed(root));
}
