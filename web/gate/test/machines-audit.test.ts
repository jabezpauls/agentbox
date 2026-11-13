import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE, MachinesAudit } from "../src/machines/audit.js";

describe("the machines audit log", () => {
  it("rotates the chatter but never a join, a token or a revocation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
    try {
      const audit = new MachinesAudit(dir, Date.now, 2_000);
      audit.record("token-issued", { machineId: "m1", name: "laptop" });
      audit.record("revoked", { machineId: "m1" });
      for (let i = 0; i < 200; i++) audit.record("online", { machineId: "m1", detail: `round ${i}` });
      const kinds = audit.list(1_000).map((e) => e.kind);
      expect(kinds).toContain("token-issued");
      expect(kinds).toContain("revoked");
      // Rotated: far fewer than 200 online events remain, and the newest is first.
      expect(kinds.filter((k) => k === "online").length).toBeLessThan(200);
      expect(audit.list(1)[0]?.detail).toBe("round 199");
      expect((fs.statSync(path.join(dir, AUDIT_FILE)).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
