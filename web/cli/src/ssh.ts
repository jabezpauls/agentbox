import { createHash } from "node:crypto";
import { CliError } from "./errors.js";

/**
 * The box as an SSH host, the text half: the managed block in
 * `~/.ssh/config`, the key line added to the box's `authorized_keys`, and the
 * box's host key pinned in a known_hosts file of agentbox's own. Everything
 * here is pure, so the rules are tested without touching a real `~/.ssh`.
 *
 * The box's sshd listens on 127.0.0.1:2222 inside the sandbox and nowhere
 * else. By default the way to it is the gate's tunnel (`agentbox proxy
 * tcp:2222`), which takes this device's token; the key is a second,
 * independent lock. The fast path (`--via <host>`) reaches it through the
 * host instead: see {@link viaProxy}.
 */

/** Where the box's sshd listens, inside the sandbox. */
export const SSH_PORT = 2222;
/** The account in the box. */
export const SSH_USER = "coder";
/** On the box, as the files API names them. */
export const REMOTE_HOST_KEY = "~/.agentbox/ssh/ssh_host_ed25519_key.pub";
export const REMOTE_AUTHORIZED_KEYS = "~/.ssh/authorized_keys";
/** Here, beside the person's own `~/.ssh` files. */
export const KNOWN_HOSTS_FILE = "agentbox_known_hosts";
export const OWN_KEY = "agentbox_ed25519";

/** A public key line: type, base64, optional comment. Nothing else is accepted from the box. */
const PUBKEY = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: ([^\r\n]*))?$/;

export interface PublicKey {
  type: string;
  data: string;
  comment: string;
}

export function parsePublicKey(text: string): PublicKey | null {
  const m = PUBKEY.exec(text.trim());
  return m ? { type: m[1] as string, data: m[2] as string, comment: m[3] ?? "" } : null;
}

/** `SHA256:…`, as `ssh-keygen -l` prints it. */
export function fingerprint(key: PublicKey): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(key.data, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** The name ssh checks the box's host key under: one per box, never an address. */
export function hostKeyAlias(box: string): string {
  return `agentbox-${box}`;
}

/**
 * `authorized_keys` with `key` in it. A line already carrying the same type
 * and key, whatever its options or comment, counts as there.
 */
export function addAuthorizedKey(existing: string, key: PublicKey): { text: string; added: boolean } {
  for (const line of existing.split("\n")) {
    const words = line.trim().split(/\s+/);
    for (let i = 0; i + 1 < words.length; i++) {
      if (words[i] === key.type && words[i + 1] === key.data) return { text: existing, added: false };
    }
  }
  const base = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  const comment = key.comment ? ` ${key.comment}` : "";
  return { text: `${base}${key.type} ${key.data}${comment}\n`, added: true };
}

/** known_hosts with the box's key pinned under its alias, and no other line for that alias. */
export function pinHostKey(existing: string, alias: string, key: PublicKey): { text: string; status: "added" | "replaced" | "unchanged" } {
  const want = `${alias} ${key.type} ${key.data}`;
  const lines = existing.split("\n").filter((l) => l !== "");
  const mine = lines.filter((l) => l.split(/\s+/)[0] === alias);
  if (mine.length === 1 && mine[0] === want) return { text: existing, status: "unchanged" };
  const others = lines.filter((l) => l.split(/\s+/)[0] !== alias);
  return { text: [...others, want].join("\n") + "\n", status: mine.length ? "replaced" : "added" };
}

/** One argument for the shell ssh runs ProxyCommand with (`sh -c` here, cmd on Windows). */
export function shellArg(v: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return /[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The ProxyCommand's words for the default path: this CLI, through the gate's tunnel. */
export function tunnelProxy(cli: string[], port: number, box: string): string[] {
  return [...cli, "proxy", `tcp:${port}`, "--box", box];
}

/** A compose project name, as Docker allows it. */
export const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
/** An ssh destination: a Host alias from ~/.ssh/config, or user@host. */
export const SSH_HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/;

/**
 * The fast path, for a box whose host this machine can already ssh to
 * (`ssh <host>`): ssh to the host, then `docker exec` the box's sshd in inetd
 * mode (`agentbox-sshd -i`), which speaks SSH over that exec's stdin and
 * stdout. No address to keep right, no port on any network, and every compose
 * project on the host is a box of its own. The container is found by its
 * compose labels at each connect, so a recreated one is found again.
 */
export function viaProxy(host: string, project: string, sshOptions: string[] = []): string[] {
  if (!SSH_HOST.test(host)) throw new CliError(`"${host}" is not an ssh host to go through`);
  if (!PROJECT.test(project)) throw new CliError(`"${project}" is not a compose project name`);
  const script =
    `c=$(docker ps -q -f label=com.docker.compose.project=${project} -f label=com.docker.compose.service=ssh) && ` +
    `[ -n "$c" ] || { echo "agentbox: no running ssh service in compose project ${project} on this host" >&2; exit 1; }; ` +
    'exec docker exec -i "$c" agentbox-sshd -i';
  return ["ssh", ...sshOptions, "-T", "-o", "ClearAllForwardings=yes", "--", host, `sh -c ${shellArg(script, "linux")}`];
}

/**
 * What to run on the host to learn which compose project is the box: one line
 * per project with an `ssh` service, its name and that sshd's host key.
 */
export const FIND_PROJECTS =
  "sh -c " +
  shellArg(
    "for c in $(docker ps -q -f label=com.docker.compose.service=ssh); do " +
      "p=$(docker inspect -f '{{index .Config.Labels \"com.docker.compose.project\"}}' \"$c\") && " +
      'k=$(docker exec "$c" cat /home/coder/.agentbox/ssh/ssh_host_ed25519_key.pub 2>/dev/null) && echo "$p $k"; ' +
      "done; true",
    "linux",
  );

/** The project whose sshd has `key`, from {@link FIND_PROJECTS}' answer. */
export function projectWithKey(answer: string, key: PublicKey): string | null {
  for (const line of answer.split("\n")) {
    const [project, type, data] = line.trim().split(/\s+/);
    if (project && PROJECT.test(project) && type === key.type && data === key.data) return project;
  }
  return null;
}

const beginMarker = (box: string): string => `# >>> agentbox: ${box} `;
const endMarker = (box: string): string => `# <<< agentbox: ${box}`;

/** A value for ssh_config, quoted when it needs to be. */
function configValue(v: string): string {
  if (/["\r\n]/.test(v)) throw new CliError(`cannot put ${JSON.stringify(v)} in ~/.ssh/config`);
  return /[\s#]/.test(v) ? `"${v}"` : v;
}

export interface BlockOptions {
  box: string;
  user: string;
  /** The ProxyCommand's words (see {@link tunnelProxy}, {@link viaProxy}). */
  proxy: string[];
  identityFile: string;
  knownHostsFile: string;
  platform: NodeJS.Platform;
}

/** The managed `Host` block, markers included. */
export function renderBlock(o: BlockOptions): string {
  // ssh expands %-tokens in ProxyCommand: a literal % is %%.
  const proxy = o.proxy.map((a) => shellArg(a, o.platform).replace(/%/g, "%%")).join(" ");
  if (/[\r\n]/.test(proxy)) throw new CliError("the ProxyCommand would span lines");
  return [
    `${beginMarker(o.box)}(managed by \`agentbox ssh-setup\`; edits inside are replaced)`,
    `Host ${o.box}`,
    `  User ${configValue(o.user)}`,
    `  ProxyCommand ${proxy}`,
    `  HostKeyAlias ${hostKeyAlias(o.box)}`,
    `  UserKnownHostsFile ${configValue(o.knownHostsFile)}`,
    "  StrictHostKeyChecking yes",
    `  IdentityFile ${configValue(o.identityFile)}`,
    "  IdentitiesOnly yes",
    endMarker(o.box),
  ].join("\n");
}

/** Where the box's block is in `text`, as line indexes, or null. */
function findBlock(lines: string[], box: string): { begin: number; end: number } | null {
  const begin = lines.findIndex((l) => l.startsWith(beginMarker(box)));
  if (begin === -1) return null;
  const end = lines.findIndex((l, i) => i > begin && l.trimEnd() === endMarker(box));
  if (end === -1) throw new CliError(`~/.ssh/config has agentbox's start marker for "${box}" but not its end ("${endMarker(box)}"); fix or remove the block and run \`agentbox ssh-setup\` again`);
  return { begin, end };
}

/**
 * `~/.ssh/config` with the box's block in it. A new block goes first: ssh
 * takes the first value it finds for each option, so a `Host *` further down
 * cannot change how the box is reached.
 */
export function upsertBlock(existing: string, box: string, block: string): { text: string; status: "added" | "updated" | "unchanged" } {
  const lines = existing.split("\n");
  const at = findBlock(lines, box);
  if (at) {
    const current = lines.slice(at.begin, at.end + 1).join("\n");
    if (current === block) return { text: existing, status: "unchanged" };
    lines.splice(at.begin, at.end - at.begin + 1, ...block.split("\n"));
    return { text: lines.join("\n"), status: "updated" };
  }
  const rest = existing.replace(/^\n+/, "");
  return { text: rest ? `${block}\n\n${rest}` : `${block}\n`, status: "added" };
}

/** The block's text, or null when there is none. */
export function currentBlock(existing: string, box: string): string | null {
  const lines = existing.split("\n");
  const at = findBlock(lines, box);
  return at ? lines.slice(at.begin, at.end + 1).join("\n") : null;
}
