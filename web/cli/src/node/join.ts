import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import type { BoxClient } from "../http.js";
import { readCredentials, writeCredentials, type Credentials, type Presence } from "./credentials.js";
import { ensurePrivateDir, type NodePaths } from "./paths.js";
import { writeInitialPolicy, type FileMode } from "./policy.js";

/**
 * `agentbox node join <box>`, in the spec's order:
 *
 * 1. check what can be checked here (platform, the node folder, disk);
 * 2. install and verify what the node runs — before any token, so a failure
 *    leaves none behind;
 * 3. the machines passphrase, typed here, and the presence verifier from it;
 * 4. ask the box to join, and show the code the owner types on the machines
 *    origin's Admin page (never a link with the code in it);
 * 5. collect the node token, once, and write credentials.json;
 * 6. policy.json, only if there is none;
 * 7. register and start the service, and wait until the machine is online.
 *
 * Nothing is written before step 5 but `bin/`. A machine joined to another
 * box refuses; re-joining this box proves the old token, and stays the same
 * machine.
 */

/** herdr and Claude Code, with room to spare. */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;
export const SUPPORTED_PLATFORMS = new Set(["linux"]);

export interface JoinOptions {
  box: string;
  name: string;
  /** Folders for policy.json, when one is written; asked for when not given. */
  folders: Array<{ path: string; mode: FileMode }> | null;
}

export interface JoinSteps {
  paths: NodePaths;
  platform: string;
  arch: string;
  hostname: string;
  now: () => number;
  err: (s: string) => void;
  client: BoxClient;
  freeBytes: (dir: string) => number | null;
  install: () => Promise<void>;
  passphrase: () => Promise<string>;
  enrol: (passphrase: string) => Promise<Presence>;
  sleep: (ms: number) => Promise<void>;
  askFolders: () => Promise<Array<{ path: string; mode: FileMode }>>;
  /** Register and start the service; `null` when the owner runs `node run` themselves. */
  service: (() => Promise<void>) | null;
  /** Wait until the box shows this machine online; false on timeout. */
  waitOnline: () => Promise<boolean>;
  printPolicy: () => void;
}

interface Started {
  joinCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  name: string;
  approveAt: string | null;
}

type Polled = { status: "pending" } | { status: "denied" } | { status: "expired" } | { status: "approved"; token: string; machineId: string; name: string };

export async function joinMachine(o: JoinOptions, s: JoinSteps): Promise<Credentials> {
  const existing = readCredentials(s.paths.credentials);
  if (existing && existing.box !== o.box && existing.revokedAt === undefined) {
    throw new CliError(
      `this machine is joined to ${existing.box} already; a machine joins one box only (run \`agentbox node leave\` first)`,
    );
  }
  const rejoin = existing && existing.box === o.box && existing.revokedAt === undefined ? existing : null;

  // 1. What can be checked here.
  if (!SUPPORTED_PLATFORMS.has(s.platform)) throw new CliError(`machines on ${s.platform} are not supported yet (Linux only, for now)`);
  try {
    ensurePrivateDir(s.paths.dir);
    fs.accessSync(s.paths.dir, fs.constants.W_OK);
  } catch (err) {
    throw new CliError(`the node folder ${s.paths.dir} is not writable: ${(err as Error).message}`);
  }
  const free = s.freeBytes(s.paths.dir);
  if (free !== null && free < MIN_FREE_BYTES) {
    throw new CliError(`${s.paths.dir} has ${Math.floor(free / 2 ** 20)} MiB free; the node needs ${MIN_FREE_BYTES / 2 ** 20} MiB`);
  }

  // 2. Install and verify, before any token.
  await s.install();

  // 3. The passphrase, and the presence verifier from it.
  const presence = await s.enrol(await s.passphrase());

  // 4. Ask to join; the owner types the code on the machines origin.
  let started: Started;
  try {
    started = await s.client.json<Started>("POST", "/_gate/node/join/start", {
      auth: false,
      body: {
        json: {
          name: o.name,
          platform: s.platform,
          arch: s.arch,
          hostname: s.hostname,
          ...(rejoin ? { rejoin: { machineId: rejoin.machineId, token: rejoin.token } } : {}),
        },
      },
      what: "asking the box to join",
    });
  } catch (err) {
    if ((err as { status?: number }).status === 404) throw new CliError(`${o.box} does not have machines turned on (or is not an agentbox)`, EXIT.NOT_FOUND);
    throw err;
  }
  s.err(`\n${rejoin ? "Re-joining" : "Joining"} as "${started.name}". On the box's machines Admin page${started.approveAt ? ` (${started.approveAt})` : ""},\n`);
  s.err(`check the name, platform and address, and type this code:\n\n    ${started.userCode}\n\n`);
  s.err(`Waiting for approval (the code lasts ${Math.round(started.expiresIn / 60)} minutes)…\n`);

  // 5. The token, collected once.
  const deadline = s.now() + started.expiresIn * 1000;
  let got: Extract<Polled, { status: "approved" }> | null = null;
  while (got === null) {
    await s.sleep(Math.max(1, started.interval) * 1000);
    if (s.now() > deadline) throw new CliError("the code expired before it was approved; run `agentbox node join` again");
    let p: Polled;
    try {
      p = await s.client.json<Polled>("POST", "/_gate/node/join/poll", { auth: false, body: { json: { joinCode: started.joinCode } }, what: "waiting for approval" });
    } catch (err) {
      if (err instanceof CliError && (err.exitCode === EXIT.UNREACHABLE || (err as { status?: number }).status === 429 || ((err as { status?: number }).status ?? 0) >= 500)) continue;
      throw err;
    }
    if (p.status === "pending") continue;
    if (p.status === "denied") throw new CliError("the join was denied on the box");
    if (p.status === "expired") throw new CliError("the code expired, or was already used; run `agentbox node join` again");
    got = p;
  }
  const credentials: Credentials = {
    version: 1,
    box: o.box,
    machineId: got.machineId,
    name: got.name,
    token: got.token,
    presence,
    joinedAt: s.now(),
  };
  writeCredentials(s.paths.credentials, credentials);
  s.err(`Joined as "${got.name}" (machine ${got.machineId}).\n`);

  // 6. The policy, only if there is none.
  if (fs.existsSync(s.paths.policy)) {
    s.err(`Keeping the existing ${s.paths.policy}:\n`);
  } else {
    const folders = o.folders ?? (await s.askFolders());
    writeInitialPolicy(s.paths.policy, folders);
    s.err(`Wrote ${s.paths.policy}:\n`);
  }
  s.printPolicy();

  // 7. The service, and online.
  if (s.service) {
    await s.service();
    s.err("Waiting for the machine to show online…\n");
    if (await s.waitOnline()) s.err("Online.\n");
    else s.err("It has not come online yet; see `agentbox node status` and `agentbox node logs`.\n");
  } else {
    s.err("Start it with `agentbox node run` (no service was registered).\n");
  }
  return credentials;
}
