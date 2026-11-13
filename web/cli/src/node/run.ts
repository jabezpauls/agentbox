import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import { callControl, startControl } from "./control.js";
import { readCredentials, writeCredentials } from "./credentials.js";
import { NodeLink, type NodeLinkOptions } from "./link.js";
import type { NodePaths } from "./paths.js";
import { loadPolicy, setPaused, summarize, watchPolicy, type LoadedPolicy } from "./policy.js";
import { gatherSpecs } from "./specs.js";

/**
 * `agentbox node run`: the node itself. Holds the link, watches the policy,
 * answers the local control socket. (Supervising herdr, the HTTP server the
 * link feeds and presence challenges come in phase 4.)
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
}

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
  link.on("state", (state: string) => o.log(`link: ${state}`));
  if (policy.policy.paused) link.pause();

  const stopWatching = watchPolicy(o.paths.policy, o.home, (l) => {
    policy = l;
    sayPolicy(l);
    if (l.policy.paused && !link.isPaused) link.pause();
    else if (!l.policy.paused && link.isPaused) link.resume();
    else link.sendPolicy(summarize(l));
  });

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((r) => (finish = r));

  const control = await startControl(o.paths.control, o.paths.controlSecret, async (command) => {
    switch (command) {
      case "status":
        return { state: link.state, box: creds.box, machineId: creds.machineId, name: creds.name, paused: link.isPaused, policyProblem: policy.problem, pid: process.pid };
      case "pause":
        setPaused(o.paths.policy, true);
        link.pause();
        return { state: link.state };
      case "resume":
        setPaused(o.paths.policy, false);
        link.resume();
        return { state: link.state };
      case "leave": {
        const told = await link.leave();
        setImmediate(() => finish(EXIT.OK));
        return { told };
      }
    }
  });

  link.on("revoked", () => {
    fs.rmSync(o.paths.secrets, { recursive: true, force: true });
    writeCredentials(o.paths.credentials, { ...creds, revokedAt: now() });
    o.log(`${creds.box} revoked this machine. Its shared secrets are wiped; everything else is kept. Re-join it to use it again.`);
    finish(EXIT.OK);
  });
  link.on("state", (state: string) => {
    if (state === "left") finish(EXIT.OK);
  });
  o.signal.addEventListener("abort", () => finish(EXIT.OK), { once: true });

  link.start();
  const code = await done;
  link.stop(link.state === "revoked" ? "revoked" : "stopped");
  stopWatching();
  control.close();
  return code;
}
