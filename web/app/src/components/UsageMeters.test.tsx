import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot, UsageSnapshot } from "@workbench/shared";

import { useApp } from "../store/app.ts";
import { fromSnapshot } from "../store/session.ts";
import snapshotFixture from "../store/fixtures/snapshot.json" with { type: "json" };
import usageFixture from "../store/fixtures/usage.json" with { type: "json" };
import { UsageMeters } from "./UsageMeters.tsx";
import { AgentList } from "./AgentList.tsx";

const base = usageFixture as unknown as UsageSnapshot;
const NOW = base.computedAt;

function snapshot(edit: (u: UsageSnapshot) => void = () => {}): UsageSnapshot {
  const u = structuredClone(base);
  edit(u);
  return u;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  useApp.setState({ usage: null });
});

describe("UsageMeters", () => {
  it("renders nothing until an agent has reported", () => {
    useApp.setState({ usage: null });
    const { container } = render(<UsageMeters />);
    expect(container).toBeEmptyDOMElement();
    useApp.setState({ usage: snapshot((u) => (u.providers = [])) });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows each window as a meter, coloured by its severity", () => {
    useApp.setState({ usage: base });
    render(<UsageMeters />);
    const five = screen.getByRole("meter", { name: "Claude 5-hour window" });
    expect(five).toHaveAttribute("aria-valuenow", "21");
    expect(five).toHaveClass("is-warn");
    expect(five.getAttribute("aria-valuetext")).toMatch(/^21% used, on pace for 72% by the reset, resets in 3 hours 7 minutes/);
    expect(five).toHaveTextContent("21%→72%3h07m");
    expect(screen.getByRole("meter", { name: "Claude weekly window" })).toHaveClass("is-ok");
    // Codex has no projection yet: no arrow.
    expect(screen.getByRole("meter", { name: "Codex 5-hour window" })).not.toHaveTextContent("→");
  });

  it("counts down between pushes", () => {
    useApp.setState({ usage: base });
    render(<UsageMeters />);
    act(() => {
      vi.advanceTimersByTime(8 * 60 * 1000);
    });
    expect(screen.getByRole("meter", { name: "Claude 5-hour window" })).toHaveTextContent("2h59m");
  });

  it("warns with the time to the cap, running it down from the snapshot", () => {
    useApp.setState({
      usage: snapshot((u) => Object.assign(u.providers[0]!.fiveHour!, { usedPct: 84, projectedPct: 128, etaSeconds: 2400, severity: "hot" })),
    });
    render(<UsageMeters />);
    expect(screen.getByRole("img", { name: /5-hour limit in about 40 minutes/ })).toHaveTextContent("~40m");
    act(() => {
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(screen.getByRole("img", { name: /5-hour limit in about 39 minutes/ })).toHaveTextContent("~39m");
    expect(screen.getByRole("meter", { name: "Claude 5-hour window" })).toHaveClass("is-hot");
  });

  it("says plainly when the limit is reached", () => {
    useApp.setState({
      usage: snapshot((u) => {
        Object.assign(u.providers[0]!, { limited: true });
        Object.assign(u.providers[0]!.fiveHour!, { usedPct: 100, resetsAt: NOW + 72 * 60, projectedPct: 140, severity: "hot" });
      }),
    });
    render(<UsageMeters />);
    expect(screen.getByRole("status")).toHaveTextContent("Limit reached · resets in 1h12m");
    const five = screen.getByRole("meter", { name: "Claude 5-hour window" });
    expect(five).toHaveClass("is-hot");
    expect(five).not.toHaveTextContent("→");
  });

  it("fades old numbers and says how old", () => {
    useApp.setState({ usage: snapshot((u) => Object.assign(u.providers[0]!, { stale: true, observedAt: NOW - 6 * 60 - 5 })) });
    const { container } = render(<UsageMeters />);
    expect(screen.getByText("as of 6m ago")).toBeInTheDocument();
    expect(container.querySelectorAll(".usage-provider.is-stale")).toHaveLength(1);
  });
});

describe("AgentList usage", () => {
  function session() {
    const s = structuredClone(snapshotFixture) as unknown as SessionSnapshot;
    const pane = s.panes[0]!;
    s.panes.push({ ...pane, pane_id: "w1:p2", focused: false });
    s.agents = s.panes.map((p) => ({ ...p, agent: "claude", agent_status: "working" as const, interactive_ready: true, launch_pending: false }));
    return fromSnapshot(s);
  }

  it("shows each agent's model and context by its pane", () => {
    render(<AgentList session={session()} usage={base} onFocusPane={() => {}} />);
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Opus 5.5");
    expect(rows[0]).toHaveTextContent("53%");
    expect(rows[1]).toHaveTextContent("Sonnet 5");
    expect(rows[1]!.querySelector(".agent-ctx")).toHaveClass("is-hot");
  });

  it("says Limit on an agent whose plan is capped", () => {
    const capped = snapshot((u) => {
      Object.assign(u.providers[0]!, { limited: true });
      u.providers[0]!.fiveHour!.usedPct = 100;
    });
    render(<AgentList session={session()} usage={capped} onFocusPane={() => {}} />);
    expect(screen.getAllByText("Limit")).toHaveLength(2);
  });

  it("shows nothing extra without a report", () => {
    render(<AgentList session={session()} usage={null} onFocusPane={() => {}} />);
    expect(screen.queryByText(/ctx/)).toBeNull();
  });
});
