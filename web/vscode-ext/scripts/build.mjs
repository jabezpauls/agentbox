// Build the extension and package it as a VSIX, without vsce.
//
// A VSIX is a zip: the extension's files under `extension/`, a manifest
// describing it, and a content-types table. vsce would pull in a large
// dependency tree to write those three things, so this writes them directly.
// The result installs with `code-server --install-extension <file>` and is what
// the workspace image bakes in.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const out = path.join(here, "dist");
fs.rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [path.join(here, "src/extension.ts")],
  outfile: path.join(out, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // code-server's extension host runs its own Node; stay within what any
  // current release ships.
  target: "node18",
  // `vscode` is provided by the host; ws's native accelerators are optional
  // and it loads them only if present.
  external: ["vscode", "bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escape(pkg.name)}" Version="${escape(pkg.version)}" Publisher="${escape(pkg.publisher)}" />
    <DisplayName>${escape(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${escape(pkg.description)}</Description>
    <Tags></Tags>
    <Categories>${escape(pkg.categories.join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escape(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${escape(pkg.extensionKind.join(","))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".md" ContentType="text/markdown" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
`;

// The installed manifest: what VS Code reads, without the build's own fields.
const { scripts: _s, devDependencies: _d, dependencies: _deps, ...installed } = pkg;

// Fixed timestamps, so the same sources always make the same bytes and the
// stamp below changes only when the extension does.
const entry = { mtime: new Date("2020-01-01T00:00:00Z"), mode: 0o100644 };
const vsix = path.join(out, "agentbox-connect.vsix");
const zip = new yazl.ZipFile();
zip.addBuffer(Buffer.from(manifest), "extension.vsixmanifest", entry);
zip.addBuffer(Buffer.from(contentTypes), "[Content_Types].xml", entry);
zip.addBuffer(Buffer.from(JSON.stringify(installed, null, 2)), "extension/package.json", entry);
zip.addBuffer(fs.readFileSync(path.join(out, "extension.js")), "extension/dist/extension.js", entry);
zip.addBuffer(fs.readFileSync(path.join(here, "README.md")), "extension/README.md", entry);
zip.end();
await new Promise((resolve, reject) => {
  zip.outputStream.pipe(fs.createWriteStream(vsix)).on("close", resolve).on("error", reject);
});
// The image's entrypoint compares this stamp with the one recorded on a home
// volume at its last install, and reinstalls when they differ — a changed
// extension reaches existing volumes even if its version was not bumped.
const hash = createHash("sha256").update(fs.readFileSync(vsix)).digest("hex").slice(0, 16);
fs.writeFileSync(path.join(out, "agentbox-connect.version"), `${pkg.version}+${hash}\n`);
console.log(`built ${path.relative(process.cwd(), vsix)} (${pkg.publisher}.${pkg.name} ${pkg.version}+${hash})`);
