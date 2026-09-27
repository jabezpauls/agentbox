import { beforeEach, describe, expect, it } from "vitest";
import { clampDockWidth, dockOnSwitch, readDockMemory } from "./dock.ts";

beforeEach(() => localStorage.clear());

describe("dock memory", () => {
  it("remembers the dock per surface", () => {
    // Open beside the Workbench...
    let shape = dockOnSwitch("workbench", "files", { open: true, width: 480 });
    // ...Files has never been seen, so it keeps what the dock was doing.
    expect(shape).toEqual({ open: true, width: 480 });
    // Closed over Files.
    shape = dockOnSwitch("files", "workbench", { open: false, width: 480 });
    expect(shape).toEqual({ open: true, width: 480 });
    shape = dockOnSwitch("workbench", "files", shape);
    expect(shape).toEqual({ open: false, width: 480 });
  });

  it("survives a reload", () => {
    dockOnSwitch("home", "apps", { open: true, width: 400 });
    expect(readDockMemory()).toEqual({ home: { open: true, width: 400 } });
  });

  it("ignores garbage in storage", () => {
    localStorage.setItem("agentbox.dock", "{not json");
    expect(readDockMemory()).toEqual({});
    localStorage.setItem("agentbox.dock", JSON.stringify({ home: { open: "yes" } }));
    expect(readDockMemory()).toEqual({});
  });
});

describe("clampDockWidth", () => {
  it("stays between the floor and 60% of the window", () => {
    expect(clampDockWidth(100, 1600)).toBe(320);
    expect(clampDockWidth(2000, 1600)).toBe(960);
    expect(clampDockWidth(500, 1600)).toBe(500);
    // A window too narrow for 60% to reach the floor still gets the floor.
    expect(clampDockWidth(500, 400)).toBe(320);
  });
});
