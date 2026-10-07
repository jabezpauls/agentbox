import fs from "node:fs";
import path from "node:path";
import type { AgentUsage, ProviderUsage, UsageProvider, UsageSnapshot, UsageWindow } from "@workbench/shared";
import {
  emptyAccountStore,
  emptyProjectionStore,
  forecastEta,
  normalizeProjectionStore,
  projectionForWindow,
  reconcileAccount,
  resetPlausible,
  RL_IDLE_TTL_S,
  WINDOWS,
  type AccountStore,
  type ProjectionStore,
  type WindowKey,
} from "./predict.js";
import { contextSeverity, windowSeverity } from "./severity.js";
import type { UsageReport } from "./report.js";

/**
 * A provider's numbers are marked stale when no live reading has arrived for
 * this long. The same ten minutes after which the forecast stops trusting a
 * session's unchanged numbers (RL_IDLE_TTL_S): past it, nothing has shown
 * that the account's usage is still what was last seen.
 */
export const STALE_AFTER_S = RL_IDLE_TTL_S;
/** Sessions are listed for an hour after their last report. */
export const AGENT_HORIZON_S = 3600;
const MAX_AGENTS = 64;
/** Accounts kept per provider: a few /login switches' worth. */
const MAX_ACCOUNTS = 8;
/** Reports arrive up to once a second per session; changes are pushed at most this often. */
const PUSH_DELAY_MS = 1000;
/** The slow timer that lets stale, ETA and severity transitions land without a report. */
const TICK_MS = 30_000;
/** How often Codex's session logs are looked at. */
const CODEX_POLL_MS = 20_000;
/** Writes of the state file are gathered up for this long. */
const PERSIST_DELAY_MS = 5_000;

interface AccountState {
  latest: AccountStore;
  projection: ProjectionStore;
  /** The freshest live reading's time: what `observedAt` and `stale` are made of. */
  liveAt: number | null;
  /** The newest reading's own view of each window, kept for display when the store has nothing for it. */
  seen: Partial<Record<WindowKey, [number, number]>>;
  touchedAt: number;
}

interface AgentRecord extends AgentUsage {
  activity: string | null;
}

interface Persisted {
  version: 1;
  accounts: Record<UsageProvider, Record<string, AccountState>>;
  agents: AgentRecord[];
}

/** Something that produces reports on a poll: Codex's session-log reader. */
export interface ReportSource {
  poll(): Promise<UsageReport[]>;
}

export interface UsageServiceOptions {
  /** Where the state persists (`~/.agentbox/usage.json`); null keeps it in memory only. */
  file?: string | null;
  /**
   * Claude Code's `~/.claude.json`, which names the logged-in account. The 5h
   * and 7d windows belong to an account, so readings are kept per account and
   * a `/login` to another one starts from that account's own history instead
   * of mixing the two. Null (or unreadable): one unnamed account.
   */
  claudeAccountFile?: string | null;
  /** Codex's session-log reader, polled while the service runs. */
  codex?: ReportSource | null;
  /** Epoch seconds. */
  clock?: () => number;
}

const ACCOUNT_UUID = /"accountUuid"\s*:\s*"([0-9a-fA-F-]{8,64})"/;

/**
 * The usage meters' state: every session's reports, reconciled per account,
 * projected, and handed out as a UsageSnapshot. The bridge is the one writer,
 * so the state is kept here in memory and written back to the home volume now
 * and then.
 */
export class UsageService {
  private readonly file: string | null;
  private readonly accountFile: string | null;
  private readonly codex: ReportSource | null;
  private readonly clock: () => number;
  private accounts: Record<UsageProvider, Record<string, AccountState>> = { claude: {}, codex: {} };
  private readonly agents = new Map<string, AgentRecord>();
  private readonly listeners = new Set<(s: UsageSnapshot) => void>();
  private last: UsageSnapshot;
  private lastKey = "";
  private accountMemo: { sig: string; id: string | null } = { sig: "", id: null };
  private pushTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private codexTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(opts: UsageServiceOptions = {}) {
    this.file = opts.file ?? null;
    this.accountFile = opts.claudeAccountFile ?? null;
    this.codex = opts.codex ?? null;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.load();
    this.last = this.compute();
    this.lastKey = changeKey(this.last);
  }

  /** The snapshot last computed. */
  current(): UsageSnapshot {
    return this.last;
  }

  on(listener: (s: UsageSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Recompute now, tell listeners if anything they show changed, and return the result. */
  refresh(): UsageSnapshot {
    const snap = this.compute();
    this.last = snap;
    const key = changeKey(snap);
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const l of this.listeners) l(snap);
    }
    this.schedulePersist();
    return snap;
  }

  /** Take one session's report. Changes reach listeners within PUSH_DELAY_MS. */
  ingest(report: UsageReport): void {
    const key = report.provider === "claude" ? this.claudeAccount() : "default";
    const acct = this.account(report.provider, key, report.at);
    const prior = this.agents.get(report.sessionId);
    const active = report.activity !== null && prior !== undefined && prior.activity !== report.activity;

    if (report.rates) {
      const r = reconcileAccount(acct.latest, report.rates, report.at, {
        sessionId: report.sessionId,
        model: report.modelId ?? report.model,
      });
      // The forecast's own test of a live reading, or — beyond the original —
      // a session that has talked to the API since its last report: the
      // harness refreshed the numbers then, even if they did not move.
      const plausible = WINDOWS.every((w) => {
        const reset = w === "five_hour" ? report.rates!.resets5h : report.rates!.resets7d;
        return reset === null || resetPlausible(w, reset, report.at);
      });
      if (r.live || (active && plausible)) acct.liveAt = Math.max(acct.liveAt ?? 0, report.at);
      if (r.used5h !== null && r.resets5h !== null) acct.seen.five_hour = [r.used5h, r.resets5h];
      if (r.used7d !== null && r.resets7d !== null) acct.seen.seven_day = [r.used7d, r.resets7d];
    }

    this.agents.set(report.sessionId, {
      paneId: report.paneId,
      sessionId: report.sessionId,
      provider: report.provider,
      model: report.model,
      contextPct: report.contextPct,
      contextSize: report.contextSize,
      contextSeverity: contextSeverity(report.contextPct),
      observedAt: report.at,
      activity: report.activity,
    });
    this.schedulePush();
  }

  /** Start the slow timer and Codex's polling. */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.refresh(), TICK_MS);
    this.tickTimer.unref();
    if (this.codex) {
      void this.pollCodex();
      this.codexTimer = setInterval(() => void this.pollCodex(), CODEX_POLL_MS);
      this.codexTimer.unref();
    }
  }

  /** Stop every timer and write the state out. */
  stop(): void {
    for (const t of [this.tickTimer, this.codexTimer, this.pushTimer, this.persistTimer]) if (t) clearTimeout(t);
    this.tickTimer = this.codexTimer = this.pushTimer = this.persistTimer = null;
    this.persistNow();
  }

  /** Read Codex's logs once and take what is new; for the timer, and for tests. */
  async pollCodex(): Promise<void> {
    if (!this.codex || this.polling) return;
    this.polling = true;
    try {
      const reports = await this.codex.poll();
      for (const r of reports) this.ingest(r);
    } catch {
      // An unreadable log is no reading; the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.refresh();
    }, PUSH_DELAY_MS);
    this.pushTimer.unref();
  }

  private compute(): UsageSnapshot {
    const now = this.clock();
    const providers: ProviderUsage[] = [];
    for (const provider of ["claude", "codex"] as const) {
      const key = provider === "claude" ? this.claudeAccount() : "default";
      const acct = this.accounts[provider][key];
      if (!acct) continue;
      const since = acct.latest.regime?.changed_at ?? null;
      const windows: Partial<Record<WindowKey, UsageWindow | null>> = {};
      for (const w of WINDOWS) {
        const reading = pickReading(acct, w, now);
        if (!reading) {
          windows[w] = null;
          continue;
        }
        const [used, resetsAt] = reading;
        const projectedPct = projectionForWindow(acct.projection, w, used, resetsAt, now, "", since);
        windows[w] = {
          usedPct: used,
          resetsAt,
          projectedPct,
          etaSeconds: forecastEta(w, used, resetsAt, now),
          severity: windowSeverity(used, projectedPct),
        };
      }
      const fiveHour = windows.five_hour ?? null;
      const sevenDay = windows.seven_day ?? null;
      if (!fiveHour && !sevenDay && acct.liveAt === null) continue;
      providers.push({
        provider,
        fiveHour,
        sevenDay,
        observedAt: acct.liveAt,
        stale: acct.liveAt === null || now - acct.liveAt > STALE_AFTER_S,
        limited: (fiveHour?.usedPct ?? 0) >= 100 || (sevenDay?.usedPct ?? 0) >= 100,
      });
    }

    for (const [id, a] of this.agents) if (now - a.observedAt > AGENT_HORIZON_S) this.agents.delete(id);
    const agents = [...this.agents.values()]
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, MAX_AGENTS)
      .map((a): AgentUsage => ({
        paneId: a.paneId,
        sessionId: a.sessionId,
        provider: a.provider,
        model: a.model,
        contextPct: a.contextPct,
        contextSize: a.contextSize,
        contextSeverity: a.contextSeverity,
        observedAt: a.observedAt,
      }));
    return { providers, agents, computedAt: Math.floor(now) };
  }

  private account(provider: UsageProvider, key: string, at: number): AccountState {
    const all = this.accounts[provider];
    let acct = all[key];
    if (!acct) {
      acct = { latest: emptyAccountStore(), projection: emptyProjectionStore(), liveAt: null, seen: {}, touchedAt: at };
      all[key] = acct;
      const keys = Object.keys(all);
      if (keys.length > MAX_ACCOUNTS) {
        keys.sort((a, b) => all[a]!.touchedAt - all[b]!.touchedAt);
        for (const k of keys.slice(0, keys.length - MAX_ACCOUNTS)) delete all[k];
      }
    }
    acct.touchedAt = Math.max(acct.touchedAt, at);
    return acct;
  }

  /**
   * The logged-in Claude account's uuid, read from `~/.claude.json` (anchored
   * on `oauthAccount` so another `accountUuid` cannot shadow it) and
   * remembered until the file changes. "default" when there is none to read:
   * an API key, or no login yet.
   */
  private claudeAccount(): string {
    if (!this.accountFile) return "default";
    let sig: string;
    try {
      const st = fs.statSync(this.accountFile);
      sig = `${st.mtimeMs}:${st.size}`;
    } catch {
      return "default";
    }
    if (sig !== this.accountMemo.sig) {
      let id: string | null = null;
      try {
        const text = fs.readFileSync(this.accountFile, "utf8");
        const anchor = text.indexOf('"oauthAccount"');
        id = ACCOUNT_UUID.exec(anchor >= 0 ? text.slice(anchor) : text)?.[1] ?? null;
      } catch {
        id = null;
      }
      this.accountMemo = { sig, id };
    }
    return this.accountMemo.id ? this.accountMemo.id.slice(0, 12) : "default";
  }

  private load(): void {
    if (!this.file) return;
    let data: Partial<Persisted>;
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Persisted>;
    } catch {
      return; // none yet, or unreadable: start afresh
    }
    if (!data || data.version !== 1) return;
    for (const provider of ["claude", "codex"] as const) {
      const accts = data.accounts?.[provider];
      if (!accts || typeof accts !== "object") continue;
      for (const [key, a] of Object.entries(accts)) {
        if (!a || typeof a !== "object") continue;
        const latest = a.latest && typeof a.latest === "object" ? a.latest : emptyAccountStore();
        this.accounts[provider][key] = {
          latest: {
            five_hour: latest.five_hour ?? {},
            seven_day: latest.seven_day ?? {},
            sessions: latest.sessions ?? {},
            ...(latest.regime ? { regime: latest.regime } : {}),
          },
          projection: normalizeProjectionStore(a.projection),
          liveAt: typeof a.liveAt === "number" ? a.liveAt : null,
          seen: a.seen && typeof a.seen === "object" ? a.seen : {},
          touchedAt: typeof a.touchedAt === "number" ? a.touchedAt : 0,
        };
      }
    }
    for (const a of Array.isArray(data.agents) ? data.agents : []) {
      if (a && typeof a.sessionId === "string" && typeof a.observedAt === "number") this.agents.set(a.sessionId, a);
    }
  }

  private schedulePersist(): void {
    if (!this.file || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DELAY_MS);
    this.persistTimer.unref();
  }

  /** Write the state out atomically: a reader (or a crash) never sees half a file. */
  private persistNow(): void {
    if (!this.file) return;
    const data: Persisted = { version: 1, accounts: this.accounts, agents: [...this.agents.values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
      console.warn("[workbench] could not save usage state", err);
    }
  }
}

/**
 * The reading a window shows: the freshest stored bucket whose window has not
 * reset yet, else what the newest report itself saw. Once the reset passes
 * with no reading of the new window, there is nothing honest to show: the
 * window starts over at an unknown reset, so it is null until a session
 * reports again.
 */
function pickReading(acct: AccountState, w: WindowKey, now: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestAt = -Infinity;
  for (const [k, b] of Object.entries(acct.latest[w] ?? {})) {
    const reset = Number(k);
    if (!Number.isFinite(reset) || reset <= now || !resetPlausible(w, reset, now)) continue;
    const at = b.observed_at ?? 0;
    if (typeof b.used === "number" && at > bestAt) {
      best = [b.used, reset];
      bestAt = at;
    }
  }
  if (best) return best;
  const seen = acct.seen[w];
  if (seen && seen[1] > now && resetPlausible(w, seen[1], now)) return seen;
  return null;
}

/**
 * What a client shows, less what it can work out for itself: countdowns run
 * from `computedAt`, so neither that nor the ETA's exact seconds are a reason
 * to push; ETA appearing or going is. Times are compared to the minute.
 */
function changeKey(s: UsageSnapshot): string {
  return JSON.stringify({
    providers: s.providers.map((p) => ({
      ...p,
      observedAt: p.observedAt === null ? null : Math.floor(p.observedAt / 60),
      fiveHour: p.fiveHour && { ...p.fiveHour, etaSeconds: p.fiveHour.etaSeconds !== null },
      sevenDay: p.sevenDay && { ...p.sevenDay, etaSeconds: p.sevenDay.etaSeconds !== null },
    })),
    agents: s.agents.map((a) => ({ ...a, observedAt: Math.floor(a.observedAt / 60) })),
  });
}
