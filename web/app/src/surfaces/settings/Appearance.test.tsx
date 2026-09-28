import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useRouter } from "../../shell/router.ts";
import { useEditorFollowsTheme } from "../../theme/editorSync.ts";
import { SettingsSurface } from "./SettingsSurface.tsx";

beforeEach(() => {
  localStorage.clear();
  useEditorFollowsTheme.setState({ on: true });
  useRouter.setState({ route: { surface: "settings", section: "appearance" }, mounted: ["settings"], last: {} });
});

describe("Settings → Appearance", () => {
  it("lets the editor stop following the app's theme, and remembers it here", async () => {
    render(<SettingsSurface />);
    const toggle = screen.getByRole("switch", { name: "Editor follows the app's theme" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(useEditorFollowsTheme.getState().on).toBe(false);
    expect(localStorage.getItem("agentbox.editorFollowsTheme")).toBe("off");
  });
});
