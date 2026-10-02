import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { probe } = vi.hoisted(() => ({ probe: vi.fn(() => Promise.resolve(false)) }));
vi.mock("../terminal/fullscreen.ts", () => ({ probeFullScreen: probe }));

import { PaneCompose } from "./PaneCompose.tsx";
import { focusTerminal, registerTerminal, type TerminalHandle } from "../terminal/registry.ts";
import { useAltScreen } from "../terminal/modes.ts";

const PANE = "w1:p1";
let term: { [K in keyof TerminalHandle]: ReturnType<typeof vi.fn> };
let unregister: () => void;

beforeEach(() => {
  localStorage.clear();
  probe.mockReset();
  probe.mockResolvedValue(false);
  useAltScreen.setState({ [PANE]: false });
  term = { focus: vi.fn(), text: vi.fn(() => ""), send: vi.fn(), submit: vi.fn(), arrow: vi.fn() };
  unregister = registerTerminal(PANE, term as unknown as TerminalHandle);
});
afterEach(() => unregister());

const field = () => screen.getByLabelText("Compose a line for the terminal") as HTMLTextAreaElement;

describe("the compose bar", () => {
  it("sends the line and Enter as one write, and clears", async () => {
    render(<PaneCompose paneId={PANE} />);
    await userEvent.type(field(), "ls -la{Enter}");
    expect(term.submit).toHaveBeenCalledWith("ls -la");
    expect(field().value).toBe("");
    // A bare Enter still reaches the program (to answer a prompt, say).
    await userEvent.type(field(), "{Enter}");
    expect(term.submit).toHaveBeenLastCalledWith("");
  });

  it("keeps Shift+Enter as a newline in the draft", async () => {
    render(<PaneCompose paneId={PANE} />);
    await userEvent.type(field(), "one{Shift>}{Enter}{/Shift}two");
    expect(field().value).toBe("one\ntwo");
    expect(term.submit).not.toHaveBeenCalled();
  });

  it("walks its history with ↑ and ↓, keeps the draft, and remembers it per pane", async () => {
    const { unmount } = render(<PaneCompose paneId={PANE} />);
    await userEvent.type(field(), "first{Enter}second{Enter}draft");
    await userEvent.keyboard("{ArrowUp}");
    expect(field().value).toBe("second");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(field().value).toBe("first");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(field().value).toBe("draft");
    unmount();
    render(<PaneCompose paneId={PANE} />);
    field().focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(field().value).toBe("second");
  });

  it("lets ↑ move between lines of a multi-line draft before it reaches history", async () => {
    render(<PaneCompose paneId={PANE} />);
    await userEvent.type(field(), "old{Enter}a{Shift>}{Enter}{/Shift}b");
    await userEvent.keyboard("{ArrowUp}");
    expect(field().value).toBe("a\nb");
  });

  it("passes Esc, Ctrl+C, Ctrl+D and Tab straight through", async () => {
    render(<PaneCompose paneId={PANE} />);
    field().focus();
    await userEvent.keyboard("{Escape}");
    expect(term.send).toHaveBeenLastCalledWith("\x1b");
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(term.send).toHaveBeenLastCalledWith("\x03");
    await userEvent.keyboard("{Control>}d{/Control}");
    expect(term.send).toHaveBeenLastCalledWith("\x04");
    await userEvent.type(field(), "git sta{Tab}");
    expect(term.send).toHaveBeenLastCalledWith("git sta\t");
    expect(field().value).toBe("");
    await userEvent.click(screen.getByTitle("Up"));
    expect(term.arrow).toHaveBeenLastCalledWith("A");
    await userEvent.click(screen.getByTitle("Ctrl+C — interrupt"));
    expect(term.send).toHaveBeenLastCalledWith("\x03");
  });

  it("takes the pane's focus while it is up", () => {
    render(<PaneCompose paneId={PANE} />);
    focusTerminal(PANE);
    expect(document.activeElement).toBe(field());
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("steps aside for a full-screen program, and comes back with the keyboard after", async () => {
    render(<PaneCompose paneId={PANE} />);
    await userEvent.type(field(), "vim");
    act(() => useAltScreen.setState({ [PANE]: true }));
    expect(screen.queryByLabelText("Compose a line for the terminal")).toBeNull();
    expect(term.focus).toHaveBeenCalled();
    // Meanwhile the pane's focus goes to the terminal itself.
    focusTerminal(PANE);
    expect(term.focus).toHaveBeenCalledTimes(2);
    act(() => useAltScreen.setState({ [PANE]: false }));
    expect(document.activeElement).toBe(field());
  });
});

describe("knowing a full-screen program", () => {
  it("steps aside while herdr reports one in the foreground, since herdr does not relay the alternate screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PaneCompose paneId={PANE} />);
    field().focus();
    probe.mockResolvedValue(true);
    await act(async () => {
      fireEvent.change(field(), { target: { value: "vim notes.md" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(probe).toHaveBeenCalledWith(PANE);
    expect(screen.queryByLabelText("Compose a line for the terminal")).toBeNull();
    probe.mockResolvedValue(false);
    await act(() => vi.advanceTimersByTimeAsync(1600));
    expect(field()).toBeInTheDocument();
    expect(document.activeElement).toBe(field());
    vi.useRealTimers();
  });
});

describe("dictation in the compose bar", () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn(() => this.onend?.());
    abort = vi.fn();
    constructor() {
      FakeRecognition.last = this;
    }
    say(text: string, isFinal: boolean) {
      this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
    }
  }
  afterEach(() => {
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  it("is offered but disabled, saying why, where the browser has no speech recognition", () => {
    render(<PaneCompose paneId={PANE} />);
    const mic = screen.getByRole("button", { name: "Dictate" });
    expect(mic).toHaveAttribute("aria-disabled", "true");
    expect(mic.title).toMatch(/Chrome, Edge or Safari/);
  });

  it("shows words as they are heard and inserts the settled ones at the caret, unsent", async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<PaneCompose paneId={PANE} />);
    await userEvent.type(field(), "echo ");
    await userEvent.click(screen.getByRole("button", { name: "Dictate" }));
    const rec = FakeRecognition.last!;
    expect(rec.start).toHaveBeenCalled();
    expect(rec.interimResults).toBe(true);
    act(() => rec.say("hello wor", false));
    expect(screen.getByText("hello wor")).toBeInTheDocument();
    act(() => rec.say("hello world", true));
    expect(field().value).toBe("echo hello world");
    expect(term.submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(rec.stop).toHaveBeenCalled();
  });

  it("explains a blocked microphone", async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<PaneCompose paneId={PANE} />);
    await userEvent.click(screen.getByRole("button", { name: "Dictate" }));
    act(() => {
      FakeRecognition.last!.onerror?.({ error: "not-allowed" });
      FakeRecognition.last!.onend?.();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Microphone blocked/);
  });

  it("talks while Ctrl+Alt+M is held", () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    render(<PaneCompose paneId={PANE} />);
    fireEvent.keyDown(field(), { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
    const rec = FakeRecognition.last!;
    expect(rec.start).toHaveBeenCalled();
    now.mockReturnValue(2500);
    fireEvent.keyUp(field(), { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
    expect(rec.stop).toHaveBeenCalled();
    now.mockRestore();
  });
});
