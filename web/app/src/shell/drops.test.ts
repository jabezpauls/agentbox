import { afterEach, describe, expect, it } from "vitest";
import { installDropGuard } from "./drops.ts";

function drag(type: string, types: string[], target: EventTarget = document.body) {
  const dataTransfer = { types, dropEffect: "copy" };
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(ev);
  return { ev, dataTransfer };
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("installDropGuard", () => {
  it("cancels a file drop nobody took, so the browser does not open the file", () => {
    uninstall = installDropGuard();
    const over = drag("dragover", ["Files"]);
    expect(over.ev.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(drag("drop", ["Files"]).ev.defaultPrevented).toBe(true);
  });

  it("leaves a drop that something took alone", () => {
    uninstall = installDropGuard();
    const zone = document.createElement("div");
    document.body.append(zone);
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "copy";
    });
    expect(drag("dragover", ["Files"], zone).dataTransfer.dropEffect).toBe("copy");
    zone.remove();
  });

  it("ignores drags that carry no files (text, rows moved within the page)", () => {
    uninstall = installDropGuard();
    expect(drag("dragover", ["text/plain"]).ev.defaultPrevented).toBe(false);
    expect(drag("drop", ["text/plain"]).ev.defaultPrevented).toBe(false);
  });
});
