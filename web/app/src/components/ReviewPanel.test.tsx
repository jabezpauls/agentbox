import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { ReviewSession } from "@workbench/shared";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { useApp } from "../store/app.ts";

const OPEN: ReviewSession = {
  key: "a1b2c3d4",
  label: "Rollout plan",
  file: "/workspace/demo/plan.html",
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  status: "open",
  pending: 0,
};

interface Posted {
  comments: { kind: string; anchor?: string; note: string }[];
  end: boolean;
}

let sessions: ReviewSession[];
let posted: Posted[];

/** Stand in for the bridge: the panel's four calls, and nothing else. */
function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

  if (url.endsWith("/api/review/sessions")) return json(sessions);
  if (/\/api\/review\/[0-9a-f]{8}$/.test(url)) {
    const key = url.slice(-8);
    const session = sessions.find((s) => s.key === key);
    return session ? json({ session, comments: [] }) : json({ session: OPEN, comments: [] });
  }
  if (url.endsWith("/feedback")) {
    const body = JSON.parse(String(init?.body)) as Posted;
    posted.push(body);
    const session = { ...OPEN, status: body.end ? ("ended" as const) : ("open" as const) };
    sessions = [session];
    return json({ session, comments: [] });
  }
  if (url.endsWith("/end")) {
    const session = { ...OPEN, status: "ended" as const, endedBy: "human" as const };
    sessions = [session];
    return json(session);
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
}

beforeEach(() => {
  sessions = [OPEN];
  posted = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  act(() => {
    useApp.getState().setInspector({ reviewKey: null });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewPanel", () => {
  it("lists the sessions an agent has published", async () => {
    render(<ReviewPanel />);
    const row = await screen.findByRole("button", { name: /Rollout plan/ });
    expect(row).toBeInTheDocument();
    expect(within(row).getByText("plan.html")).toBeInTheDocument();
  });

  it("explains the one command when there is nothing to review", async () => {
    sessions = [];
    render(<ReviewPanel />);
    expect(await screen.findByText("Nothing to review.")).toBeInTheDocument();
    expect(screen.getByText(/agentbox-review open/)).toBeInTheDocument();
  });

  it("frames the artifact with an opaque origin and no same-origin access", async () => {
    render(<ReviewPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Rollout plan/ }));
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe.review-frame");
      if (!el) throw new Error("no frame yet");
      return el;
    });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toContain("/api/review/a1b2c3d4/artifact");
  });

  it("sends a free-form note and clears the composer", async () => {
    render(<ReviewPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Rollout plan/ }));
    const note = await screen.findByLabelText("Note");
    await userEvent.type(note, "otherwise good");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ end: false });
    expect(posted[0]?.comments).toEqual([{ kind: "note", note: "otherwise good" }]);
    expect(note).toHaveValue("");
  });

  it("Send & end closes the session and returns to the list", async () => {
    render(<ReviewPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Rollout plan/ }));
    await userEvent.type(await screen.findByLabelText("Note"), "ship it");
    await userEvent.click(screen.getByRole("button", { name: "Send & end" }));

    await waitFor(() => expect(posted[0]?.end).toBe(true));
    await waitFor(() => expect(useApp.getState().ui.inspector.reviewKey).toBeNull());
  });

  it("turns an anchor the annotator reports into a comment with its quote", async () => {
    render(<ReviewPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Rollout plan/ }));
    const frame = (await waitFor(() => {
      const el = document.querySelector("iframe.review-frame");
      if (!el) throw new Error("no frame yet");
      return el;
    })) as HTMLIFrameElement;

    // The panel only trusts messages from its own frame, so the event has to
    // claim that source the way a real one would.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            source: "agentbox-review",
            kind: "element",
            selector: "body > h2:nth-of-type(2)",
            text: "Rollout plan",
          },
        }),
      );
    });

    const anchored = await screen.findByLabelText("Comment on Rollout plan");
    await userEvent.type(anchored, "split this into two phases");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.comments[0]).toMatchObject({
      kind: "element",
      anchor: "body > h2:nth-of-type(2)",
      note: "split this into two phases",
    });
  });

  it("ignores a message that is not from its own frame", async () => {
    render(<ReviewPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Rollout plan/ }));
    await screen.findByLabelText("Note");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { source: "agentbox-review", kind: "element", selector: "body", text: "spoofed" },
        }),
      );
    });

    expect(screen.queryByLabelText("Comment on spoofed")).not.toBeInTheDocument();
  });
});
