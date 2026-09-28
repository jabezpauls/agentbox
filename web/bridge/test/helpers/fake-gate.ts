import type { App } from "@workbench/shared";
import { GateError, type AppFields, type GateApps, type WatchResult } from "../../src/apps/gate.js";

/** The gate's sandbox-side API, in memory, as strict about ports as the real one. */
export class FakeGate implements GateApps {
  apps: App[] = [];
  revision = 0;
  sharing = true;
  private waiters: Array<() => void> = [];
  private n = 0;

  private bump(): void {
    this.revision += 1;
    for (const w of this.waiters.splice(0)) w();
  }
  async list() {
    return structuredClone(this.apps);
  }
  async get(id: string) {
    return structuredClone(this.apps.find((a) => a.id === id) ?? null);
  }
  async create(f: AppFields) {
    if (f.port === 7800) throw new GateError(400, { error: "infrastructure_port", message: "port 7800 belongs to agentbox itself" });
    const app: App = {
      id: `app${String(++this.n).padStart(23, "a")}`,
      name: f.name ?? `port ${f.port}`,
      port: f.port as number,
      keepPrefix: f.keepPrefix ?? false,
      ...(f.cwd ? { cwd: f.cwd } : {}),
      ...(f.command ? { command: f.command } : {}),
      pinned: f.pinned ?? false,
      createdBy: "agent",
      createdAt: 1,
      visibility: { mode: "private", expiresAt: null },
      compat: "auto",
    };
    this.apps.push(app);
    this.bump();
    return structuredClone(app);
  }
  async update(id: string, f: AppFields) {
    const app = this.apps.find((a) => a.id === id);
    if (!app) throw new GateError(404, { error: "no such app" });
    Object.assign(app, f);
    this.bump();
    return structuredClone(app);
  }
  async remove(id: string) {
    const before = this.apps.length;
    this.apps = this.apps.filter((a) => a.id !== id);
    if (this.apps.length !== before) this.bump();
    return this.apps.length !== before;
  }
  async watch(since: number, waitMs: number, signal?: AbortSignal): Promise<WatchResult> {
    if (since === this.revision) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(waitMs, 200));
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
        signal?.addEventListener("abort", () => r());
      });
    }
    return { revision: this.revision, sharing: this.sharing };
  }
}
