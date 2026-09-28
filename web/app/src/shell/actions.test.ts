import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store/app.ts";
import { handleShellKey } from "./actions.ts";

function press(target: HTMLElement, init: KeyboardEventInit): boolean {
  let taken = false;
  const listen = (e: KeyboardEvent) => {
    taken = handleShellKey(e);
  };
  window.addEventListener("keydown", listen);
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  window.removeEventListener("keydown", listen);
  return taken;
}

let field: HTMLInputElement;
beforeEach(() => {
  field = document.createElement("input");
  document.body.append(field);
  useApp.getState().setUi({ palette: null, dialog: null });
});
afterEach(() => {
  field.remove();
  useApp.getState().setUi({ palette: null, dialog: null });
});

describe("handleShellKey and the palette key", () => {
  it("opens the palette on Ctrl+K where nothing is being typed", () => {
    expect(press(document.body, { key: "k", code: "KeyK", ctrlKey: true })).toBe(true);
    expect(useApp.getState().ui.palette).not.toBeNull();
  });

  it("leaves Ctrl+K to a text field", () => {
    expect(press(field, { key: "k", code: "KeyK", ctrlKey: true })).toBe(false);
    expect(useApp.getState().ui.palette).toBeNull();
  });

  it("still opens it on ⌘K, and on the chord, from a text field", () => {
    expect(press(field, { key: "k", code: "KeyK", metaKey: true })).toBe(true);
    useApp.getState().setUi({ palette: null });
    expect(press(field, { key: "k", code: "KeyK", ctrlKey: true, altKey: true })).toBe(true);
    expect(useApp.getState().ui.palette).not.toBeNull();
  });
});
