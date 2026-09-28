import os from "node:os";
import { bool, str } from "../args.js";
import { openBrowser } from "../browser.js";
import { checkBoxName, defaultBoxName, hasBox, isLoopbackHost, normalizeBoxUrl, publicView, type ConfigData } from "../config.js";
import type { Context } from "../context.js";
import { pollForToken, safeVerifyUrl, startDeviceLogin } from "../device.js";
import { ApiError, CliError, EXIT } from "../errors.js";
import { formatAgo, safeText, table } from "../format.js";
import { VERSION } from "../version.js";
import { command, type Command } from "./types.js";

/** What `/_gate/session` says about a device token. */
interface TokenSession {
  kind: "token" | "session";
  id: string;
  name?: string;
  user: string;
  createdAt: number;
}

/** A name for a new box that no other box has. */
function freeName(base: string, data: ConfigData, origin: string): string {
  let name = base;
  for (let n = 2; hasBox(data.boxes, name) && data.boxes[name]?.url !== origin; n++) name = `${base}-${n}`;
  return name;
}

/** Revoke a token this machine no longer uses, as far as the box can be reached; never fails. */
async function revokeQuietly(ctx: Context, origin: string, token: string): Promise<void> {
  await ctx
    .client(origin, token)
    .json("DELETE", "/_gate/tokens/self", { idleMs: 10_000 })
    .catch(() => {});
}

export const login = command({
  path: ["login"],
  summary: "sign this machine in to a box (in your browser)",
  usage: "<url>",
  operands: { min: 1, max: 1 },
  json: true,
  options: [
    { name: "name", type: "string", value: "name", description: "what to call the box here (default: from its address)" },
    { name: "device", type: "string", value: "label", description: 'how this device is listed on the box (default: "agentbox CLI on <hostname>")' },
    { name: "no-browser", type: "boolean", description: "print the approval link instead of opening a browser" },
  ],
  details:
    "Shows a code and opens the box's approval page; approve it there, signed in, and this machine\n" +
    "gets a device token of its own. Your password never passes through the CLI.",
  async run(ctx, p) {
    const origin = normalizeBoxUrl(p.operands[0] as string);
    const url = new URL(origin);
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      ctx.warn(`${origin} is plain http: the device token will cross the network unencrypted. Use https unless this network is yours alone.`);
    }
    const data = ctx.config.load();
    const asked = str(p.options, "name");
    const name = asked
      ? checkBoxName(asked)
      : (Object.entries(data.boxes).find(([, b]) => b.url === origin)?.[0] ?? freeName(defaultBoxName(origin), data, origin));
    const existing = hasBox(data.boxes, name) ? data.boxes[name] : undefined;
    if (asked && existing && existing.url !== origin) {
      throw new CliError(`a box named "${name}" is already ${existing.url}; pick another --name, or \`agentbox logout --box ${name}\` first`);
    }
    const device = str(p.options, "device") ?? `agentbox CLI on ${os.hostname()}`;

    const anonymous = ctx.client(origin, null);
    const start = await startDeviceLogin(anonymous, device);
    const verify = safeVerifyUrl(start.verifyUrl, origin, start.userCode);
    ctx.err(
      `\nTo sign this device in, open this page where you are signed in to the box:\n\n  ${safeText(verify)}\n\n` +
        `and check it shows this code:\n\n  ${safeText(start.userCode)}\n\n`,
    );
    let opened = false;
    if (!bool(p.options, "no-browser")) opened = await openBrowser(verify, ctx.platform, ctx.env);
    ctx.err(`${opened ? "Opened your browser. " : ""}Waiting for approval (the code is good for ${Math.round(start.expiresIn / 60)} minutes; Ctrl-C to give up)…\n`);

    const token = await pollForToken(anonymous, start, { signal: ctx.abort.signal });
    const client = ctx.client(origin, token);
    let session: TokenSession;
    try {
      session = await client.json<TokenSession>("GET", "/_gate/session", { what: "checking the new sign-in" });
      if (typeof session?.id !== "string" || typeof session.user !== "string") throw new CliError("the box's answer about the new sign-in is not one this CLI knows");
    } catch (err) {
      // Never kept, so never left valid at the box either.
      await revokeQuietly(ctx, origin, token);
      throw err;
    }

    // Tokens this sign-in replaces: this box's own earlier one, and the box
    // saved under another name (a new --name for the same address). Left
    // alone they would sit in Settings → Devices, valid and unused.
    const replaced: Array<{ name: string; token: string }> = [];
    ctx.config.update((d) => {
      for (const [other, box] of Object.entries(d.boxes)) {
        if (box.url !== origin || box.token === token) continue;
        replaced.push({ name: other, token: box.token });
        if (other !== name) delete d.boxes[other];
      }
      d.boxes[name] = {
        url: origin,
        token,
        tokenId: session.id,
        user: session.user,
        device: session.name ?? device,
        addedAt: ctx.now(),
      };
      d.current = name;
    });
    for (const r of replaced) await revokeQuietly(ctx, origin, r.token);
    const version = await ctx.checkVersion(name, client);
    if (ctx.json) {
      ctx.printJson({ ...publicView(name, ctx.config.load().boxes[name]!, true), boxVersion: version, replaced: replaced.map((r) => r.name).filter((n) => n !== name) });
    } else {
      for (const r of replaced) if (r.name !== name) ctx.err(`Replaced the box saved as "${r.name}" (same address), and revoked its token.\n`);
      ctx.out(`Signed in to ${origin} as ${safeText(session.user)}. This box is "${name}" here, and the current one.\n`);
    }
  },
});

export const logout = command({
  path: ["logout"],
  summary: "revoke this machine's token and forget the box",
  usage: "",
  options: [
    {
      name: "local",
      type: "boolean",
      description: "forget the box here without revoking (when the box cannot be reached; revoke it in Settings → Devices)",
    },
  ],
  async run(ctx, p) {
    const { name, box } = ctx.selected();
    let revoked = false;
    if (!bool(p.options, "local")) {
      const client = ctx.client(box.url, box.token);
      try {
        await client.json("DELETE", "/_gate/tokens/self", { what: "revoking this device's token" });
        revoked = true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Already revoked (from Settings, or by revoke-all): nothing to undo.
        } else if (err instanceof CliError && err.exitCode === EXIT.UNREACHABLE) {
          throw new CliError(
            `${err.message}. Nothing was changed. To forget the box here anyway — its token stays valid until you revoke it in Settings → Devices — run \`agentbox logout --local\`.`,
            EXIT.UNREACHABLE,
          );
        } else {
          throw err;
        }
      }
    }
    ctx.config.update((d) => {
      delete d.boxes[name];
      if (d.current === name) d.current = Object.keys(d.boxes)[0] ?? null;
    });
    ctx.out(
      revoked
        ? `Signed out of ${name} (${box.url}); its token is revoked.\n`
        : bool(p.options, "local")
          ? `Forgot ${name} (${box.url}) here. Its token is still valid: revoke it in Settings → Devices.\n`
          : `Forgot ${name} (${box.url}); its token had already been revoked.\n`,
    );
  },
});

export const whoami = command({
  path: ["whoami"],
  summary: "who and where this machine is signed in",
  usage: "",
  json: true,
  async run(ctx) {
    const { name, box, client } = await ctx.connect({ checkVersion: false });
    const [session, version] = await Promise.all([
      client.json<TokenSession>("GET", "/_gate/session", { what: "asking the box who this is" }),
      ctx.checkVersion(name, client),
    ]);
    if (ctx.json) {
      ctx.printJson({
        box: name,
        url: box.url,
        user: session.user,
        kind: session.kind,
        device: session.name ?? null,
        tokenId: session.id,
        createdAt: session.createdAt,
        boxVersion: version,
        cliVersion: VERSION,
      });
      return;
    }
    ctx.out(`${safeText(String(session.user))} on ${name} (${box.url})\n`);
    ctx.out(`  device   ${safeText(session.name ?? "-")}, signed in ${formatAgo(session.createdAt, ctx.now())}\n`);
    ctx.out(`  version  box ${safeText(version ?? "unknown")}, this CLI ${VERSION}\n`);
  },
});

export const boxes = command({
  path: ["boxes"],
  summary: "list the boxes this machine is signed in to",
  usage: "",
  json: true,
  async run(ctx) {
    const data = ctx.config.load();
    const names = Object.keys(data.boxes).sort();
    if (ctx.json) {
      ctx.printJson(names.map((n) => publicView(n, data.boxes[n]!, n === data.current)));
      return;
    }
    if (names.length === 0) {
      ctx.out("Not signed in to any box. Run `agentbox login <url>`.\n");
      return;
    }
    ctx.out(
      table(
        ["", "NAME", "URL", "USER"],
        names.map((n) => [n === data.current ? "*" : "", n, data.boxes[n]!.url, safeText(data.boxes[n]!.user ?? "-")]),
      ),
    );
  },
});

export const use = command({
  path: ["use"],
  summary: "make a box the current one",
  usage: "<name>",
  operands: { min: 1, max: 1 },
  async run(ctx, p) {
    const name = p.operands[0] as string;
    const url = ctx.config.update((d) => {
      const box = hasBox(d.boxes, name) ? d.boxes[name] : undefined;
      if (!box) throw new CliError(`no box named "${name}" (see \`agentbox boxes\`)`, EXIT.NOT_FOUND);
      d.current = name;
      return box.url;
    });
    ctx.out(`Now using ${name} (${url}).\n`);
  },
});

export const AUTH_COMMANDS: Command[] = [login, logout, whoami, boxes, use];
