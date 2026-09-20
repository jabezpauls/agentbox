import { describe, it, expect } from "vitest";
import { isAllowed } from "../src/rpc-allowlist.js";

describe("rpc allowlist", () => {
  const allowed = [
    "ping",
    "session.snapshot",
    "workspace.create",
    "worktree.list",
    "tab.rename",
    "pane.split",
    "agent.prompt",
    "layout.set_split_ratio",
    "notification.show",
  ];
  const denied = [
    "server.stop",
    "server.reload_config",
    "integration.install",
    "plugin.link",
    "events.subscribe",
    "",
    "pane",
    "pane.",
  ];

  for (const method of allowed) {
    it(`allows ${method}`, () => {
      expect(isAllowed(method)).toBe(true);
    });
  }

  for (const method of denied) {
    it(`denies ${JSON.stringify(method)}`, () => {
      expect(isAllowed(method)).toBe(false);
    });
  }
});
