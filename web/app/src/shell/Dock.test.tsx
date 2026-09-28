import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store/app.ts";

vi.mock("../components/PreviewPanel.tsx", () => ({ PreviewPanel: () => <p>preview</p> }));
vi.mock("../components/ReviewPanel.tsx", () => ({ ReviewPanel: () => <p>review</p> }));

const { Dock } = await import("./Dock.tsx");
const { DOCK_MIN, dockMaxWidth } = await import("./dock.ts");

beforeEach(() => {
  act(() => useApp.getState().setInspector({ open: true, tab: "preview", width: 480 }));
});

describe("the dock's edge", () => {
  it("is a separator that says its range and where it is", async () => {
    render(<Dock />);
    const edge = screen.getByRole("separator", { name: "Resize the dock" });
    expect(edge).toHaveAttribute("aria-valuemin", String(DOCK_MIN));
    expect(edge).toHaveAttribute("aria-valuemax", String(dockMaxWidth(window.innerWidth)));
    expect(edge).toHaveAttribute("aria-valuenow", "480");

    const user = userEvent.setup();
    edge.focus();
    await user.keyboard("{ArrowLeft}");
    expect(edge).toHaveAttribute("aria-valuenow", "496");
    await user.keyboard("{Home}");
    expect(edge).toHaveAttribute("aria-valuenow", String(DOCK_MIN));
    await user.keyboard("{End}");
    expect(edge).toHaveAttribute("aria-valuenow", String(dockMaxWidth(window.innerWidth)));
  });
});
