import fs from "node:fs";
import path from "node:path";
import { SessionHub, TerminalStreams, type Viewer } from "@workbench/hostcore/herdr";
import { CliError, EXIT } from "../errors.js";
import { claudePaths, holdToken, installedClaude, prepareClaude } from "./claude.js";
import { HerdrSupervisor, HERDR_SESSION } from "./herdr.js";
import { withPath, windowsShell, writeHerdrConfig, writeShellShim } from "./proc.js";
import { GUI_EXE } from "./service-windows.js";
import { PresenceGate } from "./presence.js";
import { NodeServer } from "./server.js";
import { callControl, startControl } from "./control.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { NodeLink, type NodeLinkOptions } from "./link.js";
import type { NodePaths } from "./paths.js";
import { loadPolicy, setPaused, summarize, watchPolicy, type LoadedPolicy } from "./policy.js";
import { herdrDir, herdrPath, HERDR_VERSION } from "./install.js";
import { execStart } from "./service-linux.js";
import { gatherSpecs } from "./specs.js";
import { checkForUpdate, describeReport } from "./update.js";
import { filesFor, pathRules, TRASH_DAYS, windowsDocuments } from "./files.js";
import { Previews, writePreviewShim } from "./preview.js";
import type { FilesService } from "@workbench/hostcore/files";

/** The exit code of a node that replaced itself: not 0, so the service restarts it. */
export const RESTART_EXIT = 75;

/**
 * `agentbox node run`: the node itself. Holds the link, watches the policy,
 * answers the local control socket, supervises herdr, serves the streams the
 * gate opens with its HTTP server (server.ts), answers presence challenges,
 * and keeps Claude Code's shim, config and the shared token (claude.ts).
 *
 * Revoked — by the box's signed message only — it wipes `secrets/`, notes the
 * revocation in credentials.json, says so, and exits 0, so the service is not
 * restarted. Nothing else is deleted.
 */

export interface RunOptions {
  paths: NodePaths;
  home: string;
  version: string;
  log: (line: string) => void;
  signal: AbortSignal;
  now?: () => number;
  /** Link timings (tests shorten them). */
  link?: Partial<Omit<NodeLinkOptions, "box" | "token" | "machineId" | "version" | "describe">>;
  /** Check for signed updates (tests turn it off). */
  checkUpdates?: boolean;
  /** How often open channels are checked against the policy and presence. */
  enforceMs?: number;
}

/** After a fresh herdr start, restored panes get a viewer this size for this long, so their programs resume. */
const HEADLESS = { cols: 200, rows: 50, ms: 30_000 };

export async function runNode(o: RunOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const creds = readCredentials(o.paths.credentials);
  if (!creds) throw new CliError("this machine has not joined a box; run `agentbox node join <box>`", EXIT.NOT_FOUND);
  if (creds.revokedAt !== undefined) {
    o.log(`this machine was revoked by ${creds.box} on ${new Date(creds.revokedAt).toISOString()}; re-join it to use it again`);
    return EXIT.OK;
  }
  if ((await callControl(o.paths.control, o.paths.controlSecret, "status", 2_000)) !== null) {
    throw new CliError("a node is already running on this machine (see `agentbox node status`)");
  }

  let policy: LoadedPolicy = loadPolicy(o.paths.policy, o.home);

  // Claude Code: its shim first on herdr's PATH, its own config, agents.md.
  const claude = claudePaths(o.paths);
  prepareClaude(claude, { home: o.home, machine: creds.name });
  // On Windows herdr is in bin\herdr\ (its own CLI streams the terminals, by
  // name), and its panes run PowerShell (pwsh when it is there) through a
  // shell shim that puts these folders on PATH again (proc.ts).
  const win = process.platform === "win32";
  const onPath = [claude.shims, o.paths.bin, ...(win ? [herdrDir(o.paths.bin)] : [])];
  const herdrEnv: NodeJS.ProcessEnv = withPath(process.env, onPath);
  if (win) herdrEnv.HERDR_CONFIG_PATH = writeHerdrConfig(path.join(o.paths.dir, "herdr-config.toml"), writeShellShim(claude.shims, onPath, windowsShell(herdrEnv)));
  delete herdrEnv.CLAUDE_CODE_OAUTH_TOKEN;

  // Files: the policy's folders, behind the lists the box can never get past (files.ts).
  const rules = pathRules({ home: o.home, nodeDir: o.paths.dir, ...(win ? { documents: windowsDocuments() } : {}) });
  let files: FilesService | null = null;
  let filesKey = "";
  let stopUploads: () => void = () => {};
  const setFiles = (l: LoadedPolicy): void => {
    const key = JSON.stringify(l.policy.files);
    if (key === filesKey) return;
    filesKey = key;
    stopUploads();
    files = filesFor(l.policy, o.paths, rules);
    stopUploads = files ? files.startMaintenance() : () => {};
  };
  setFiles(policy);
  // Trashed things are kept 7 days.
  const sweepTrash = (): void => {
    void files?.trash.expire(now() - TRASH_DAYS * 24 * 60 * 60_000).then(
      (n) => n && o.log(`files: ${n} item(s) older than ${TRASH_DAYS} days removed from the trash`),
      () => {},
    );
  };
  sweepTrash();
  const trashSweeper = setInterval(sweepTrash, 60 * 60_000);
  trashSweeper.unref();

  // Apps for the owner's Preview (preview.ts), and `agentbox-preview` to register them.
  const previews = new Previews({ now });
  previews.start();
  writePreviewShim(claude.shims);

  const presence = new PresenceGate({ presence: creds.presence, machineId: creds.machineId, hours: () => policy.policy.presenceHours, now, log: o.log });

  // herdr, and what is built on its socket (a fresh one at each start).
  let hub: SessionHub | null = null;
  let streams: TerminalStreams | null = null;
  const herdrBin = herdrPath(o.paths.bin);
  const herdr = fs.existsSync(herdrBin) ? new HerdrSupervisor({ bin: herdrBin, dir: o.paths.dir, env: herdrEnv }) : null;
  if (!herdr) o.log(`herdr is not installed (${herdrBin}); terminals and agents are unavailable until \`agentbox node join\` installs it`);
  const server = new NodeServer({
    herdrSocket: () => herdr?.socketPath ?? null,
    hub: () => hub,
    streams: () => streams,
    policy: () => policy,
    presence,
    home: o.home,
    files: () => files,
    previews,
    log: o.log,
  });
  herdr?.on("log", (line: string) => o.log(line));
  herdr?.on("down", () => {
    hub?.stop();
    hub = null;
    streams?.stop();
    streams = null;
  });
  herdr?.on("ready", (socket: string, info: { restored: boolean; envPath: string }) => {
    hub?.stop();
    streams?.stop();
    const h = new SessionHub(socket);
    hub = h;
    streams = new TerminalStreams({ ...herdrEnv, HERDR_SOCKET_PATH: info.envPath, HERDR_SESSION });
    const own = streams;
    const connect = (tries: number): void => {
      h.start().then(
        async () => {
          if (!info.restored || hub !== h) return;
          // Restored panes, with no browser yet: a headless viewer sized 200×50 for a while.
          const snap = await h.snapshot().catch(() => null);
          const quiet: Viewer = { send: () => {}, sendJson: () => {}, close: () => {} };
          const held = (snap?.panes ?? []).map((p) => own.attach(p.pane_id, quiet, HEADLESS.cols, HEADLESS.rows));
          if (held.length) o.log(`herdr: ${held.length} restored pane(s) attached headless at ${HEADLESS.cols}×${HEADLESS.rows}`);
          setTimeout(() => held.forEach((a) => a.detach()), HEADLESS.ms).unref();
        },
        () => {
          if (hub === h && tries > 0) setTimeout(() => connect(tries - 1), 1_000).unref();
        },
      );
    };
    connect(10);
  });
  const sayPolicy = (l: LoadedPolicy): void => {
    if (l.problem) o.log(`policy: ${l.problem}; everything is denied until it is fixed`);
    else o.log(`policy: terminals ${l.policy.terminals ? "on" : "off"}, ${l.policy.files.length} folder(s), ports ${l.policy.ports ? "on" : "off"}${l.policy.paused ? ", paused" : ""}`);
  };
  sayPolicy(policy);

  const link = new NodeLink({
    box: creds.box,
    token: creds.token,
    machineId: creds.machineId,
    version: o.version,
    describe: async () => {
      const summary = summarize(policy);
      return { ...(await gatherSpecs({ binDir: o.paths.bin, policy: summary })), policy: summary };
    },
    ...(o.link ?? {}),
  });
  link.on("log", (line: string) => o.log(line));
  // The box's machine-apps registry follows this list: all of it, each time it changes and on every link up.
  const sendApps = (): void => {
    link.sendControl({ type: "apps", apps: previews.list().map((a) => ({ port: a.port, name: a.name })) });
  };
  previews.on("change", () => {
    sendApps();
    server.enforce();
  });
  link.on("welcome", sendApps);
  // Each stream the gate opens is a connection to the node's server.
  link.on("stream", (stream: import("node:stream").Duplex, open: import("@workbench/hostcore/link").StreamOpen) => server.accept(stream, open));
  link.on("control", (m: { type: string; token?: unknown }) => {
    if (m.type !== "claude-token") return;
    const token = typeof m.token === "string" ? m.token : null;
    holdToken(claude, token);
    o.log(token ? "the box sent the shared Claude sign-in; new Claude Code sessions here use it" : "the box withdrew the shared Claude sign-in from this machine");
  });
  link.on("state", (state: string) => o.log(`link: ${state}`));
  if (policy.policy.paused) link.pause();

  const stopWatching = watchPolicy(o.paths.policy, o.home, (l) => {
    policy = l;
    sayPolicy(l);
    setFiles(l);
    if (!l.policy.ports) previews.clear();
    // Tightened: what it no longer allows closes now.
    const closed = server.enforce();
    if (closed) o.log(`policy: closed ${closed} channel(s) it no longer allows`);
    if (l.policy.paused && !link.isPaused) link.pause();
    else if (!l.policy.paused && link.isPaused) link.resume();
    else link.sendPolicy(summarize(l));
  });

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((r) => (finish = r));

  const control = await startControl(o.paths.control, o.paths.controlSecret, async (command, args) => {
    switch (command) {
      case "preview": {
        if (!policy.policy.ports) throw new Error("apps are off in this machine's policy.json (\"ports\": false)");
        if (args.share === true) throw new Error("apps on a machine cannot be shared publicly yet");
        const r = await previews.register(args.port, args.name);
        if (!r.ok) throw new Error(r.error);
        o.log(`preview: port ${r.app.port} registered as "${r.app.name}"`);
        return { app: r.app, existed: r.existed, online: link.state === "online" };
      }
      case "preview-list":
        return { apps: previews.list() };
      case "preview-stop": {
        const port = Number(args.port);
        if (!previews.remove(port)) throw new Error(`no app is registered on port ${args.port}`);
        return { removed: port };
      }
      case "status":
        return {
          state: link.state,
          box: creds.box,
          machineId: creds.machineId,
          name: creds.name,
          paused: link.isPaused,
          policyProblem: policy.problem,
          pid: process.pid,
          herdrSocket: herdr?.envPath ?? null,
          presenceLocked: presence.locked(),
          channels: server.openChannels,
        };
      case "pause":
        setPaused(o.paths.policy, true);
        link.pause();
        return { state: link.state };
      case "resume":
        setPaused(o.paths.policy, false);
        link.resume();
        return { state: link.state };
      case "passphrase": {
        // `agentbox node passphrase` wrote a new verifier: the old passphrase answers nothing from now.
        const fresh = readCredentials(o.paths.credentials);
        if (!fresh) throw new Error("credentials.json cannot be read");
        presence.rekey(fresh.presence);
        const closed = server.enforce();
        o.log(`presence: the machines passphrase changed on this machine; every grant ended${closed ? ` (${closed} channel(s) closed)` : ""}`);
        return {};
      }
      case "leave": {
        const told = await link.leave();
        setImmediate(() => finish(EXIT.OK));
        return { told };
      }
    }
  });

  link.on("revoked", () => {
    fs.rmSync(o.paths.secrets, { recursive: true, force: true });
    writeCredentials(o.paths.credentials, { ...(readCredentials(o.paths.credentials) ?? creds), revokedAt: now() });
    o.log(`${creds.box} revoked this machine. Its shared secrets are wiped; everything else is kept. Re-join it to use it again.`);
    finish(EXIT.OK);
  });
  link.on("state", (state: string) => {
    if (state === "left") finish(EXIT.OK);
  });
  o.signal.addEventListener("abort", () => finish(EXIT.OK), { once: true });

  // Signed updates from GitHub Releases (update.ts): daily, and when the gate
  // answers `upgrade`. A replaced node exits with RESTART_EXIT, which the
  // service (Restart=on-failure) restarts into the new binary.
  let checking = false;
  const checkUpdates = async (): Promise<void> => {
    if (checking || o.checkUpdates === false) return;
    checking = true;
    try {
      const standalone = execStart().length === 3;
      const gui = path.join(path.dirname(process.execPath), GUI_EXE);
      const report = await checkForUpdate({
        policy: policy.policy.updates,
        running: o.version,
        // Only the standalone executable replaces itself; agentbox.mjs under Node does not.
        nodePath: standalone ? process.execPath : null,
        // Windows: the windowless copy beside it, which the sign-in entry starts.
        ...(win && standalone && fs.existsSync(gui) ? { nodeGuiPath: gui } : {}),
        ...(fs.existsSync(herdrBin) ? { herdr: { path: herdrBin, version: HERDR_VERSION } } : {}),
        ...(installedClaude(claude) ? { claude: { path: claude.bin, version: installedClaude(claude), versionFile: claude.versionFile } } : {}),
        // Agents live in herdr: herdr and Claude Code are replaced only while none runs.
        idle: () => (herdr ? herdr.idle() : true),
      });
      o.log(`update: ${describeReport(report)}`);
      if ((report.state === "current" || report.state === "updated") && report.tools.herdr === "updated") void herdr?.restart("updated");
      if (report.state === "updated" && report.restart) finish(RESTART_EXIT);
    } catch (err) {
      o.log(`update check failed: ${(err as Error).message}`);
    } finally {
      checking = false;
    }
  };
  link.on("upgrade", () => void checkUpdates());
  const firstCheck = setTimeout(() => void checkUpdates(), 10 * 60_000);
  firstCheck.unref();
  const daily = setInterval(() => void checkUpdates(), 24 * 60 * 60_000);
  daily.unref();

  // Every few seconds: grants that ended, and anything the policy closed meanwhile.
  const enforcer = setInterval(() => server.enforce(), o.enforceMs ?? 5_000);
  enforcer.unref();
  if (herdr) {
    herdr.start().catch((err: unknown) => {
      o.log(`herdr did not start: ${(err as Error).message}; trying again`);
      void herdr.restart("it did not start");
    });
  }

  link.start();
  const code = await done;
  clearInterval(enforcer);
  clearInterval(trashSweeper);
  stopUploads();
  previews.stop();
  server.close();
  // herdr keeps running, its agents with it; the next node adopts it.
  herdr?.stop();
  (hub as SessionHub | null)?.stop();
  (streams as TerminalStreams | null)?.stop();
  clearTimeout(firstCheck);
  clearInterval(daily);
  link.stop(link.state === "revoked" ? "revoked" : "stopped");
  stopWatching();
  control.close();
  return code;
}
