import { describe, expect, it } from "vitest";
import { collectDrop, collectPicked } from "./drop.ts";

type Node = { name: string; file?: string; children?: Node[] };

/** A FileSystemEntry tree, with a reader that hands entries over two at a time. */
function entry(n: Node): unknown {
  if (n.children) {
    return {
      name: n.name,
      isFile: false,
      isDirectory: true,
      createReader() {
        let i = 0;
        const all = n.children!.map(entry);
        return {
          readEntries(ok: (e: unknown[]) => void) {
            const batch = all.slice(i, i + 2);
            i += 2;
            setTimeout(() => ok(batch), 0);
          },
        };
      },
    };
  }
  return {
    name: n.name,
    isFile: true,
    isDirectory: false,
    file(ok: (f: File) => void) {
      ok(new File([n.file ?? ""], n.name));
    },
  };
}

function transfer(nodes: Node[], loose: File[] = []): DataTransfer {
  const items = [
    ...nodes.map((n) => ({ kind: "file", webkitGetAsEntry: () => entry(n), getAsFile: () => null })),
    ...loose.map((f) => ({ kind: "file", getAsFile: () => f })),
  ];
  return { items, types: ["Files"] } as unknown as DataTransfer;
}

describe("collectDrop", () => {
  it("walks a dropped folder, in every batch, keeping its shape", async () => {
    const dt = transfer([
      {
        name: "site",
        children: [
          { name: "index.html", file: "<h1>" },
          { name: "a.css" },
          { name: "img", children: [{ name: "logo.png" }] },
          { name: "empty", children: [] },
        ],
      },
      { name: "notes.md", file: "# hi" },
    ]);
    const got = await collectDrop(dt, "/workspace/demo");
    expect(got.files.map((f) => f.dest).sort()).toEqual([
      "/workspace/demo/notes.md",
      "/workspace/demo/site/a.css",
      "/workspace/demo/site/img/logo.png",
      "/workspace/demo/site/index.html",
    ]);
    expect(got.emptyDirs).toEqual(["/workspace/demo/site/empty"]);
  });

  it("takes plain files when the entry API is missing", async () => {
    const got = await collectDrop(transfer([], [new File(["x"], "a.txt")]), "/w");
    expect(got.files.map((f) => f.dest)).toEqual(["/w/a.txt"]);
  });
});

describe("collectPicked", () => {
  it("keeps a picked folder's structure", () => {
    const f = new File(["x"], "b.txt");
    Object.defineProperty(f, "webkitRelativePath", { value: "proj/src/b.txt" });
    expect(collectPicked([f, new File(["y"], "c.txt")], "/w").files.map((x) => x.dest)).toEqual(["/w/proj/src/b.txt", "/w/c.txt"]);
  });
});
