import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Menu, type MenuEntry } from "./Menu.tsx";

function Harness({ items }: { items: MenuEntry[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button onClick={(e) => setAnchor(e.currentTarget)}>Actions</button>
      {anchor && <Menu anchor={anchor} label="Actions" items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

describe("Menu", () => {
  const rename = vi.fn();
  const trash = vi.fn();
  const items: MenuEntry[] = [
    { label: "Rename", onSelect: rename },
    { separator: true },
    { label: "Disabled", disabled: true, onSelect: () => {} },
    { label: "Move to trash", danger: true, onSelect: trash },
  ];

  it("takes the keyboard once placed: arrows walk it, Enter chooses, focus goes back", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    // The disabled item is skipped.
    expect(screen.getByRole("menuitem", { name: "Move to trash" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(trash).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and gives the keyboard back", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus();
    expect(rename).not.toHaveBeenCalled();
  });

  it("jumps to an item by its first letter", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.keyboard("m");
    expect(screen.getByRole("menuitem", { name: "Move to trash" })).toHaveFocus();
  });
});
