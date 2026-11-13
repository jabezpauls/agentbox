import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiUrl } from "../api/base.ts";
import { connectEvents } from "../api/events.ts";
import { rpc, setApiBase } from "../api/client.ts";
import { AgentList } from "../components/AgentList.tsx";
import { useApp } from "../store/app.ts";
import { TerminalCell } from "../terminal/TerminalCell.tsx";
import { useTheme } from "../theme/useTheme.ts";
import { MachinesError, machinesApi, type MachineView } from "./api.ts";
import { forgetPassphrase, heldPassphrase, holdPassphrase, presenceAnswer } from "./presence.ts";

/**
 * The machines UI, on the machines origin: the list at `/`, a machine at
 * `/machine/<id>`. A machine's page proves presence first (the passphrase,
 * typed here only), then shows its workspaces and agents live and a
 * terminal, with the Workbench's own components pointed at `/m/<id>`.
 */

const STATE_LABEL: Record<MachineView["state"], string> = {
  online: "online",
  offline: "offline",
  paused: "paused on the machine",
  revoked: "revoked",
  left: "left",
};

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

function specsLine(m: MachineView): string {
  const s = m.specs;
  if (!s) return `${m.reported.platform}/${m.reported.arch} · ${m.reported.hostname}`;
  return [
    `${s.platform}/${s.arch}`,
    s.hostname,
    `${s.cpu.cores} × ${s.cpu.model || "CPU"}`,
    `${gib(s.ramBytes)} RAM`,
    ...s.gpus.map((g) => `GPU ${g.name}`),
    s.docker ? "Docker" : "no Docker",
    s.claude ? `Claude Code ${s.claude}` : "no Claude Code",
  ].join(" · ");
}

function List() {
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      machinesApi.list().then(
        (m) => live && setMachines(m),
        (e: Error) => live && setError(e.message),
      );
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return (
    <main className="mx-page">
      <header className="mx-head">
        <h1 className="mx-title">Machines</h1>
        <nav className="mx-nav">
          <a className="btn" href="/admin">
            Admin
          </a>
          <button className="btn btn-ghost" type="button" onClick={() => void machinesApi.signOut().finally(() => location.replace("/signin"))}>
            Sign out
          </button>
        </nav>
      </header>
      {error && <p className="mx-error">{error}</p>}
      {machines === null ? (
        <p className="mx-hint">Loading…</p>
      ) : machines.length === 0 ? (
        <p className="mx-hint">
          No machines are joined yet. On a computer, run <code>agentbox node join</code> with this box&apos;s address, and approve it on the Admin page.
        </p>
      ) : (
        <ul className="mx-list" id="machines-list">
          {machines.map((m) => (
            <li key={m.id} className="mx-machine" data-machine={m.id} data-state={m.state}>
              <div className="mx-machine-head">
                {m.state === "online" ? <a href={`/machine/${m.id}`}>{m.name}</a> : <strong>{m.name}</strong>}
                <span className={`mx-state is-${m.state}`}>{STATE_LABEL[m.state]}</span>
              </div>
              <div className="mx-hint">{specsLine(m)}</div>
              {m.specs?.policy.problem && <div className="mx-error">policy: {m.specs.policy.problem} (everything denied)</div>}
              {m.upgradeNeeded && <div className="mx-error">Update needed: this machine&apos;s node is too old for the box.</div>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

type Phase = { kind: "checking" } | { kind: "prompt"; message: string | null } | { kind: "proving" } | { kind: "ready" } | { kind: "locked"; message: string };

/** One proof of presence for `id`; resolves with the phase it leads to. */
async function prove(id: string, passphrase: string): Promise<Phase> {
  try {
    const c = await machinesApi.challenge(id);
    const answer = await presenceAnswer(passphrase, c);
    await machinesApi.prove(id, c.challenge, answer);
    holdPassphrase(passphrase);
    return { kind: "ready" };
  } catch (err) {
    const e = err as MachinesError;
    if (e.code === "locked") return { kind: "locked", message: e.message };
    if (e.code === "wrong") {
      forgetPassphrase();
      return { kind: "prompt", message: "That is not the machines passphrase this machine knows." };
    }
    return { kind: "prompt", message: e.message || "The machine did not answer. Try again." };
  }
}

function Presence({ id, phase, onPhase }: { id: string; phase: Phase; onPhase: (p: Phase) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = value;
    setValue("");
    onPhase({ kind: "proving" });
    void prove(id, p).then(onPhase);
  };
  if (phase.kind === "locked") return <p className="mx-error" role="alert">{phase.message}</p>;
  if (phase.kind !== "prompt") return <p className="mx-hint">Checking that it is you…</p>;
  return (
    <form className="mx-presence" id="machine-presence" onSubmit={submit}>
      <p className="mx-hint">
        This machine wants proof that you are here. Type the machines passphrase — only ever in a tab whose address bar reads <strong>{location.host}</strong>.
      </p>
      <label className="field-label" htmlFor="presence-passphrase">
        Machines passphrase
      </label>
      <input className="input" id="presence-passphrase" type="password" autoComplete="current-password" required autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      {phase.message && (
        <p className="mx-error" role="alert">
          {phase.message}
        </p>
      )}
      <button className="btn btn-primary" type="submit">
        Continue
      </button>
    </form>
  );
}

function Workspaces({ selected, onSelect }: { selected: string | null; onSelect: (pane: string) => void }) {
  const session = useApp((s) => s.session);
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch(apiUrl("/api/health"))
      .then((r) => r.json() as Promise<{ workspaceRoot?: string }>)
      .then((h) => setCwd((c) => c || h.workspaceRoot || ""))
      .catch(() => {});
  }, []);
  const create = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    rpc("workspace.create", { cwd }).catch((err: Error) => setError(err.message));
  };
  const panesOf = (ws: string) => Object.values(session.panes).filter((p) => p.workspace_id === ws);
  return (
    <div className="mx-side">
      <h2 className="mx-sub">Workspaces</h2>
      <ul className="mx-ws" id="machine-workspaces">
        {session.workspaces.map((w) => (
          <li key={w.workspace_id}>
            <div className="mx-ws-label">{w.label}</div>
            <ul>
              {panesOf(w.workspace_id).map((p) => (
                <li key={p.pane_id}>
                  <button className={`btn btn-small${p.pane_id === selected ? " btn-primary" : ""}`} type="button" data-pane={p.pane_id} onClick={() => onSelect(p.pane_id)}>
                    {p.pane_id} {p.agent ? `· ${p.display_agent ?? p.agent}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <form className="mx-new" onSubmit={create}>
        <label className="field-label" htmlFor="ws-cwd">
          New workspace in
        </label>
        <input className="input" id="ws-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
        <button className="btn" type="submit">
          Create
        </button>
        {error && <p className="mx-error">{error}</p>}
      </form>
      <h2 className="mx-sub">Agents</h2>
      <AgentList session={session} onFocusPane={onSelect} />
    </div>
  );
}

function Machine({ id }: { id: string }) {
  const { resolved } = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const status = useApp((s) => s.status);
  const focused = useApp((s) => s.session.focusedPaneId);

  // Everything the Workbench's components call goes to this machine.
  useMemo(() => setApiBase(`/m/${id}`), [id]);

  const check = useCallback(async () => {
    try {
      const p = await machinesApi.presence(id);
      if (p.granted) return setPhase({ kind: "ready" });
    } catch {
      // Asked again below.
    }
    const held = heldPassphrase();
    if (held) {
      setPhase({ kind: "proving" });
      setPhase(await prove(id, held));
    } else {
      setPhase({ kind: "prompt", message: null });
    }
  }, [id]);

  useEffect(() => {
    void machinesApi.list().then((all) => setMachine(all.find((m) => m.id === id) ?? null));
    void check();
  }, [id, check]);

  useEffect(() => {
    if (phase.kind !== "ready") return;
    const st = useApp.getState();
    return connectEvents({ onMessage: (m) => st.applyMessage(m), onStatus: (s) => st.setStatus(s) });
  }, [phase.kind]);

  // The socket keeps closing: the grant may have ended (or the policy closed it). Ask again.
  useEffect(() => {
    if (phase.kind !== "ready" || status !== "closed") return;
    const t = setTimeout(() => {
      void machinesApi.presence(id).then((p) => {
        if (!p.granted) void check();
      });
    }, 1_500);
    return () => clearTimeout(t);
  }, [phase.kind, status, id, check]);

  const pane = selected ?? focused;
  return (
    <main className="mx-page mx-machine-page" data-phase={phase.kind}>
      <header className="mx-head">
        <a className="btn btn-ghost" href="/">
          ← Machines
        </a>
        <h1 className="mx-title">{machine?.name ?? "Machine"}</h1>
        {machine && <span className={`mx-state is-${machine.state}`}>{STATE_LABEL[machine.state]}</span>}
        {phase.kind === "ready" && <span className="mx-hint" id="machine-conn">{status}</span>}
      </header>
      {machine?.specs?.policy.terminals === false && <p className="mx-error">Terminals are off in this machine&apos;s policy.json.</p>}
      {phase.kind !== "ready" ? (
        <Presence id={id} phase={phase} onPhase={setPhase} />
      ) : (
        <div className="mx-body">
          <Workspaces selected={pane} onSelect={setSelected} />
          <div className="mx-term">{pane ? <TerminalCell key={pane} paneId={pane} resolved={resolved} /> : <p className="mx-hint">Create a workspace, or pick a pane.</p>}</div>
        </div>
      )}
    </main>
  );
}

export function MachinesApp() {
  const m = /^\/machine\/([0-9a-f]{24})\/?$/.exec(location.pathname);
  return m ? <Machine id={m[1] as string} /> : <List />;
}
