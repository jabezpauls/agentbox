import { useState } from "react";
import { Activity, Gauge } from "lucide-react";
import type { SystemInfo } from "@workbench/shared";
import { useApp } from "../../store/app.ts";
import { useSystem } from "../../system/model.ts";
import { formatBytes, formatCores, formatDuration, formatMemory, plural } from "../../lib/format.ts";
import { Empty, PageHeader, Section } from "../../components/ui/Page.tsx";
import { Meter } from "../../components/ui/Meter.tsx";
import { Sparkline } from "../../components/ui/Sparkline.tsx";
import { usePolling } from "../../shell/activity.tsx";
import { useRouter } from "../../shell/router.ts";
import { useOutOfReach } from "../../shell/health.ts";

const POLL_MS = 2000;

function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null || b <= 0 ? null : a / b;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

function Overview({ info }: { info: SystemInfo }) {
  const history = useSystem((s) => s.history);
  const ports = useApp((s) => s.ports);
  const lost = useOutOfReach();
  const c = info.container;
  const versions: [string, string | null][] = [
    ["agentbox", info.versions.agentbox],
    ["herdr", info.versions.herdr],
    ["code-server", info.versions.codeServer],
    ["Node.js", info.versions.node],
    ...info.versions.agents.map((a) => [a.name, a.version] as [string, string | null]),
  ];

  return (
    <>
      <Section title="The sandbox" id="sys-sandbox">
        <p className="section-note">Every process the sandbox runs — the editor, the terminals, the agents and what they start — against the host.</p>
        <div className="meter-row">
          <div className="meter-with-trend">
            <Meter
              label="CPU"
              fraction={ratio(info.sandbox.cpu, info.host.cores)}
              value={formatCores(info.sandbox.cpu, info.host.cores)}
              sub="Busy CPUs, summed over every process"
            />
            <Sparkline
              label="CPU"
              values={history.map((h) => h.cpu)}
              max={info.host.cores}
              step={POLL_MS / 1000}
              format={(v) => formatCores(v)}
            />
          </div>
          <div className="meter-with-trend">
            <Meter
              label="Memory"
              fraction={ratio(info.sandbox.memory, info.host.memory)}
              value={`${formatMemory(info.sandbox.memory)} of ${formatMemory(info.host.memory)}`}
              sub="Resident memory, summed (shared pages count once per process)"
            />
            <Sparkline label="Memory" values={history.map((h) => h.memory)} max={info.host.memory} step={POLL_MS / 1000} format={formatMemory} />
          </div>
          <Tile label="Processes" value={info.sandbox.processes.toLocaleString()} sub="In the sandbox's process table" />
        </div>
      </Section>

      <Section title="Terminals and agents" id="sys-container">
        <p className="section-note">
          The Workbench's terminals, and the agents in them, share one container with limits of its own: these are its use against those limits. The
          editor and the monitor run in containers beside it, whose limits this view cannot read.
        </p>
        {c.readable ? (
          <div className="meter-row">
            <Meter
              label="CPU"
              fraction={ratio(c.cpu.usage, c.cpu.limit ?? info.host.cores)}
              value={formatCores(c.cpu.usage, c.cpu.limit ?? undefined)}
              sub={c.cpu.limit ? `Limited to ${formatCores(c.cpu.limit)}` : `No limit — the host's ${info.host.cores} cores`}
            />
            <Meter
              label="Memory"
              fraction={ratio(c.memory.used, c.memory.limit ?? info.host.memory)}
              value={`${formatMemory(c.memory.used)}${c.memory.limit ? ` of ${formatMemory(c.memory.limit)}` : ""}`}
              sub={c.memory.limit ? "Limit set on the container; reclaimable cache left out" : "No limit — the host's memory"}
            />
            <Meter
              label="Processes"
              fraction={ratio(c.pids.current, c.pids.limit)}
              value={`${c.pids.current ?? "—"}${c.pids.limit ? ` of ${c.pids.limit.toLocaleString()}` : ""}`}
              sub={c.pids.limit ? "Process limit" : "No process limit"}
            />
          </div>
        ) : (
          <Empty compact title="No limits to read here." sub="This host does not show a container its own limits." />
        )}
      </Section>

      <Section title="Disks" id="sys-disks">
        <div className="meter-row">
          {info.disks.map((d) => (
            <Meter
              key={d.label}
              label={d.label === "workspace" ? "Workspace" : "Home"}
              fraction={ratio(d.used, d.total)}
              value={`${formatBytes(d.used)} of ${formatBytes(d.total)}`}
              sub={`${formatBytes(d.available)} free · ${d.path}`}
            />
          ))}
        </div>
      </Section>

      <div className="sys-cols">
        <Section title="Busiest processes" id="sys-procs" count={info.processes.length}>
          <table className="table">
            <thead>
              <tr>
                <th>Process</th>
                <th className="num">PID</th>
                <th className="num">CPU</th>
                <th className="num">Memory</th>
              </tr>
            </thead>
            <tbody>
              {info.processes.map((p) => (
                <tr key={p.pid}>
                  <td className="proc" title={p.command}>
                    <span className="proc-name">{p.name}</span>
                    <span className="proc-cmd">{p.command}</span>
                  </td>
                  <td className="num mono">{p.pid}</td>
                  <td className="num">{p.cpu.toFixed(p.cpu < 10 ? 1 : 0)}%</td>
                  <td className="num">{formatMemory(p.memory)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <div className="sys-side">
          <Section title="Listening" id="sys-ports" count={lost ? undefined : ports.length}>
            {lost ? (
              <p className="section-note">Not known while the box is not answering.</p>
            ) : ports.length === 0 ? (
              <p className="section-note">Nothing is listening.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Process</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.map((p) => (
                    <tr key={`${p.address}:${p.port}`}>
                      <td className="mono">
                        {p.port}
                        {p.system && <span className="pill tag">agentbox</span>}
                      </td>
                      <td>{p.process ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Versions" id="sys-versions">
            <dl className="props">
              {versions.map(([name, v]) => (
                <div className="prop" key={name}>
                  <dt>{name}</dt>
                  <dd className="mono">{v ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Up for" id="sys-uptime">
            <dl className="props">
              <div className="prop">
                <dt>The sandbox</dt>
                <dd>{formatDuration(info.uptime.box)}</dd>
              </div>
              <div className="prop">
                <dt>The bridge</dt>
                <dd>{formatDuration(info.uptime.bridge)}</dd>
              </div>
              <div className="prop">
                <dt>The host</dt>
                <dd>{formatDuration(info.uptime.host)}</dd>
              </div>
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}

/** btop, full size, through ttyd at /monitor. Built only when asked for. */
function Monitor() {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="monitor">
      <iframe className="monitor-frame" src="/monitor/" title="Detailed monitor (btop)" onLoad={() => setLoaded(true)} />
      {!loaded && (
        <div className="editor-loading">
          <span className="empty-glyph" aria-hidden="true">
            <Activity size={22} />
          </span>
          <p className="empty-title">Starting the monitor</p>
        </div>
      )}
    </div>
  );
}

/**
 * System: how the box is doing. Two honest views — the whole sandbox
 * against the host, and the terminals' and agents' container against its
 * own limits —
 * plus disks, the busiest processes, what is listening, versions and
 * uptime. Read every two seconds while showing, and not at all otherwise.
 * "Detailed monitor" is btop.
 */
export function SystemSurface() {
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const info = useSystem((s) => s.info);
  const error = useSystem((s) => s.error);
  const [monitorBuilt, setMonitorBuilt] = useState(false);
  const view = route.surface === "system" ? route.view : "overview";
  if (view === "monitor" && !monitorBuilt) setMonitorBuilt(true);

  usePolling(() => useSystem.getState().refresh(), POLL_MS, view === "overview");

  const switcher = (
    <div className="segmented" role="tablist" aria-label="View">
      {(["overview", "monitor"] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          className={`segmented-btn${view === v ? " is-active" : ""}`}
          onClick={() => navigate({ surface: "system", view: v })}
        >
          {v === "overview" ? "Overview" : "Detailed monitor"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="system">
      <div className="page" hidden={view !== "overview"}>
        <div className="page-inner">
          <PageHeader
            title="System"
            subtitle={
              info
                ? `agentbox ${info.versions.agentbox ?? "(version unknown)"} · up ${formatDuration(info.uptime.box ?? info.uptime.bridge)} · host with ${plural(info.host.cores, "core")} and ${formatMemory(info.host.memory)}`
                : error
                  ? "The box is not answering."
                  : "Reading the box…"
            }
            actions={switcher}
          />
          {info && error && (
            <p className="notice is-warn" role="status">
              These are the last numbers read. {error}
            </p>
          )}
          {info ? (
            <Overview info={info} />
          ) : error ? (
            <Empty icon={<Gauge size={22} />} title="Couldn't read the system." sub={error} action={<button className="btn btn-small" onClick={() => void useSystem.getState().refresh()}>Retry</button>} />
          ) : (
            <div className="meter-row" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 118 }} />
              ))}
            </div>
          )}
        </div>
      </div>
      {monitorBuilt && (
        <div className="system-monitor" hidden={view !== "monitor"}>
          <header className="system-monitor-bar">
            <h1 className="page-title">System</h1>
            {switcher}
          </header>
          <Monitor />
        </div>
      )}
    </div>
  );
}
