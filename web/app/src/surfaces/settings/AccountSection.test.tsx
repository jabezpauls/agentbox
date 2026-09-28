import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceActiveContext } from "../../shell/activity.tsx";
import { useGateSession } from "../../shell/session.ts";
import { confirm, dismissPrompts } from "../../components/ui/prompts.tsx";

const gate = vi.hoisted(() => ({
  sessions: vi.fn(),
  totpSetup: vi.fn(),
  totpConfirm: vi.fn(),
}));
vi.mock("../../settings/gate.ts", async (orig) => ({
  ...(await orig<typeof import("../../settings/gate.ts")>()),
  gateApi: gate,
}));

const { AccountSection } = await import("./AccountSection.tsx");

function Host({ active }: { active: boolean }) {
  return (
    <SurfaceActiveContext.Provider value={active}>
      <AccountSection />
    </SurfaceActiveContext.Provider>
  );
}

beforeEach(() => {
  gate.sessions.mockReset().mockResolvedValue([]);
  gate.totpSetup.mockReset().mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://x", qrSvg: "<svg/>" });
  gate.totpConfirm.mockReset().mockResolvedValue({ recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] });
  useGateSession.setState({
    session: { user: "coder", twoFactor: false, remember: true, expiresAt: Date.now() + 6 * 86_400_000 } as never,
  });
});

describe("Settings → Account, leaving the surface", () => {
  it("closes the password prompt and forgets what was typed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Host active />);
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    const dialog = screen.getByRole("dialog", { name: "Turn on two-factor" });
    await user.type(dialog.querySelector('input[type="password"]')!, "hunter2");

    rerender(<Host active={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<Host active />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(screen.getByRole("dialog").querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });

  it("drops a two-factor setup that lands after Settings was left", async () => {
    let finish: (v: unknown) => void = () => {};
    gate.totpSetup.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    const { rerender } = render(<Host active />);
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await user.type(screen.getByRole("dialog").querySelector('input[type="password"]')!, "hunter2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Away before the gate answers.
    rerender(<Host active={false} />);
    await act(async () => finish({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://x", qrSvg: "<svg/>" }));
    rerender(<Host active />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears the change-password form", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<Host active />);
    const current = container.querySelector<HTMLInputElement>('form input[autocomplete="current-password"]')!;
    await user.type(current, "old-secret");
    rerender(<Host active={false} />);
    expect(current.value).toBe("");
  });

  it("names the account for password managers", () => {
    const { container } = render(<Host active />);
    const hint = container.querySelector<HTMLInputElement>('form input[autocomplete="username"]')!;
    expect(hint.value).toBe("coder");
    expect(hint.hidden).toBe(true);
  });

  it("keeps the recovery codes until they are saved, and only their button closes them", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Host active />);
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await user.type(screen.getByRole("dialog").querySelector('input[type="password"]')!, "hunter2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox", { name: "Code from the app" }), "123456");
    await user.click(within(screen.getByRole("dialog", { name: "Turn on two-factor" })).getByRole("button", { name: "Turn on" }));
    const codes = await screen.findByRole("dialog", { name: "Save your recovery codes" });

    await user.keyboard("{Escape}");
    expect(codes).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    rerender(<Host active={false} />);
    rerender(<Host active />);
    expect(screen.getByRole("dialog", { name: "Save your recovery codes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "I have saved them" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a clean error when the sessions cannot be read", async () => {
    gate.sessions.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<Host active />);
    expect(await screen.findByText("Couldn't read the sessions.")).toBeInTheDocument();
    gate.sessions.mockResolvedValue([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Couldn't read the sessions.")).toBeNull());
  });

  it("says when the session ends in words, not a timestamp", () => {
    render(<Host active />);
    expect(screen.getByText(/remembered on this browser, signs out in 6 days/)).toBeInTheDocument();
  });
});

describe("prompts", () => {
  it("answers no to a question left behind on another surface", async () => {
    const answer = confirm({ title: "Delete?", confirmLabel: "Delete" });
    act(() => dismissPrompts());
    await expect(answer).resolves.toBe(false);
  });
});
