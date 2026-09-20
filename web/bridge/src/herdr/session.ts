import { subscribe, type HerdrStreamEvent, type Subscription } from "./socket.js";
import { request } from "./socket.js";
import type { EventsMessage, HerdrEventName, SessionSnapshot } from "@workbench/shared";

/** All lifecycle subscription types herdr streams without a per-pane scope. */
const LIFECYCLE_TYPES = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
];

type Sub = { close(): void };

/**
 * Holds one lifecycle subscription and one agent-status subscription against a
 * single herdr socket, forwarding every event to registered listeners. herdr
 * scopes agent-status subscriptions per pane, so that subscription is reopened
 * (debounced) as panes come and go. The hub keeps no reducer: each browser gets
 * a fresh snapshot then the live event stream.
 */
export class SessionHub {
  private readonly socketPath: string;
  private lifecycleSub: Sub | null = null;
  private agentSub: Sub | null = null;
  private readonly panes = new Set<string>();
  private readonly listeners = new Set<(m: EventsMessage) => void>();
  private _connected = false;
  private _version: string | null = null;
  private _protocol: number | null = null;
  private stopped = false;
  private reconnecting = false;
  private reconnectDelay = 250;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private agentDebounce: NodeJS.Timeout | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  get connected(): boolean {
    return this._connected;
  }
  get version(): string | null {
    return this._version;
  }
  get protocol(): number | null {
    return this._protocol;
  }

  paneIds(): string[] {
    return [...this.panes];
  }

  on(listener: (m: EventsMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(m: EventsMessage): void {
    for (const listener of this.listeners) listener(m);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async snapshot(): Promise<SessionSnapshot> {
    const res = await request<{ snapshot: SessionSnapshot }>(this.socketPath, "session.snapshot");
    return res.snapshot;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.agentDebounce) {
      clearTimeout(this.agentDebounce);
      this.agentDebounce = null;
    }
    this.closeSubs();
    this._connected = false;
    this.listeners.clear();
  }

  private closeSubs(): void {
    if (this.lifecycleSub) {
      this.lifecycleSub.close();
      this.lifecycleSub = null;
    }
    if (this.agentSub) {
      this.agentSub.close();
      this.agentSub = null;
    }
  }

  /** Open lifecycle subscription, load the snapshot, then open agent-status. */
  private async connect(): Promise<void> {
    this.closeSubs();
    this.lifecycleSub = await subscribe(
      this.socketPath,
      LIFECYCLE_TYPES.map((type) => ({ type })),
      (e) => this.onLifecycle(e),
      () => this.onDrop(),
    );
    const snap = await this.snapshot();
    this._version = snap.version;
    this._protocol = snap.protocol;
    this.panes.clear();
    for (const p of snap.panes) this.panes.add(p.pane_id);
    await this.openAgentSub();
    this._connected = true;
  }

  private async openAgentSub(): Promise<void> {
    const subs: Subscription[] = this.paneIds().map((pane_id) => ({
      type: "pane.agent_status_changed",
      pane_id,
    }));
    const next = await subscribe(
      this.socketPath,
      subs,
      (e) => this.onAgentEvent(e),
      () => this.onDrop(),
    );
    const previous = this.agentSub;
    this.agentSub = next;
    if (previous) previous.close();
  }

  private onLifecycle(e: HerdrStreamEvent): void {
    this.emit({ kind: "event", event: e.event as HerdrEventName, data: e.data });
    let changed = false;
    if (e.event === "pane_created" || e.event === "pane_moved") {
      const paneId = (e.data as { pane?: { pane_id?: string } }).pane?.pane_id;
      if (paneId && !this.panes.has(paneId)) {
        this.panes.add(paneId);
        changed = true;
      }
    } else if (e.event === "pane_closed") {
      const paneId = (e.data as { pane_id?: string }).pane_id;
      if (paneId && this.panes.delete(paneId)) changed = true;
    }
    if (changed) this.scheduleAgentReopen();
  }

  private onAgentEvent(e: HerdrStreamEvent): void {
    this.emit({ kind: "event", event: "pane_agent_status_changed", data: e.data });
  }

  private scheduleAgentReopen(): void {
    if (this.agentDebounce) clearTimeout(this.agentDebounce);
    this.agentDebounce = setTimeout(() => {
      this.agentDebounce = null;
      this.openAgentSub().catch(() => this.onDrop());
    }, 50);
  }

  private onDrop(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this._connected = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().then(
        () => {
          this.reconnectDelay = 250;
          this.reconnecting = false;
          this.emit({ kind: "reset", reason: "herdr reconnected" });
        },
        () => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000);
          this.scheduleReconnect();
        },
      );
    }, this.reconnectDelay);
  }
}
