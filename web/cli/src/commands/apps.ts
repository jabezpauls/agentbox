import type { AppView } from "@workbench/shared";
import { bool, str } from "../args.js";
import { openBrowser } from "../browser.js";
import type { Context } from "../context.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { formatAgo, safeText, table } from "../format.js";
import type { BoxClient } from "../http.js";
import { parseForwardSpec } from "../tunnel.js";
import { runForward } from "./forward.js";
import { command, type Command } from "./types.js";

/**
 * The box's apps (`/a/<id>/`) from the terminal: the list with live state
 * comes from the bridge (`/api/apps`); sharing is the owner's alone and goes
 * to the gate (`/_gate/apps/:id/visibility`), which takes a device token.
 */

/** `7d`, `12h`, `30m`, `90s`, or `never`: seconds, or null for until stopped. */
export function parseExpiry(raw: string): number | null {
  if (raw === "never") return null;
  const m = /^(\d+)([smhdw])$/.exec(raw.trim());
  if (!m) throw new UsageError(`"${raw}" is not an expiry: give e.g. 30m, 12h, 7d, 2w or never`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as "s" | "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

async function listApps(client: BoxClient): Promise<AppView[]> {
  const apps = await client.json<AppView[]>("GET", "/api/apps", { what: "reading apps" });
  return Array.isArray(apps) ? apps : [];
}

/** An app by its id, or by its name when exactly one has it. */
export async function findApp(client: BoxClient, which: string): Promise<AppView> {
  const apps = await listApps(client);
  const byId = apps.find((a) => a.id === which);
  if (byId) return byId;
  const named = apps.filter((a) => a.name === which);
  if (named.length === 1) return named[0] as AppView;
  if (named.length > 1) throw new CliError(`${named.length} apps are called "${which}"; name one by its id (see \`agentbox apps ls\`)`, EXIT.USAGE);
  throw new CliError(`no app "${which}" on the box (see \`agentbox apps ls\`)`, EXIT.NOT_FOUND);
}

function sharing(a: AppView, now: number): string {
  const v = a.visibility;
  if (v.mode === "private") return "private";
  return `${v.mode}${v.expiresAt ? `, ends ${formatAgo(v.expiresAt, now)}` : ", until stopped"}`;
}

const ls = command({
  path: ["apps", "ls"],
  summary: "the box's apps: port, whether it is up, how it is shared",
  usage: "",
  json: true,
  async run(ctx) {
    const { box, client } = await ctx.connect();
    const apps = await listApps(client);
    if (ctx.json) {
      ctx.printJson(apps.map((a) => ({ ...a, url: `${box.url}/a/${a.id}/` })));
      return;
    }
    if (apps.length === 0) {
      ctx.err("No apps. An agent makes one with `agentbox-preview start`, or Apps → Make an app.\n");
      return;
    }
    const t = (v: unknown): string => safeText(String(v));
    ctx.out(
      table(
        ["NAME", "ID", "PORT", "STATE", "SHARING", "URL"],
        apps.map((a) => [t(a.name), t(a.id), t(a.port), a.live?.listening ? "up" : "not up", t(sharing(a, ctx.now())), `${box.url}/a/${t(a.id)}/`]),
      ),
    );
  },
});

const open = command({
  path: ["apps", "open"],
  summary: "open an app in your browser",
  usage: "<app>",
  operands: { min: 1, max: 1 },
  options: [{ name: "print", type: "boolean", description: "print the URL instead of opening it" }],
  async run(ctx, p) {
    const { box, client } = await ctx.connect();
    const app = await findApp(client, p.operands[0] as string);
    const url = `${box.url}/a/${encodeURIComponent(app.id)}/`;
    if (bool(p.options, "print") || !(await openBrowser(url, ctx.platform, ctx.env))) ctx.out(`${url}\n`);
    else ctx.err(`Opened ${url}\n`);
  },
});

const share = command({
  path: ["apps", "share"],
  summary: "make an app public: to anyone with the link, or with a passcode",
  usage: "<app>",
  operands: { min: 1, max: 1 },
  json: true,
  options: [
    { name: "expires", type: "string", value: "time", description: "when sharing ends: 30m, 12h, 7d (default), 2w, or never" },
    { name: "passcode", type: "boolean", description: "ask visitors for a passcode (the box makes one, shown once)" },
    { name: "set-passcode", type: "string", value: "text", description: "ask visitors for this passcode (8 characters or more)" },
  ],
  details: "Its URL stays the one you already use; `agentbox apps unshare` makes it private again and cuts off anyone still connected.",
  async run(ctx, p) {
    const { box, client } = await ctx.connect();
    const app = await findApp(client, p.operands[0] as string);
    const chosen = str(p.options, "set-passcode");
    const passcode = chosen !== undefined || bool(p.options, "passcode");
    const expires = str(p.options, "expires");
    const body: Record<string, unknown> = { mode: passcode ? "passcode" : "link" };
    if (expires !== undefined) body.expiresIn = parseExpiry(expires);
    if (chosen !== undefined) body.passcode = chosen;
    const shared = await client.json<AppView & { passcode?: string }>("PUT", `/_gate/apps/${encodeURIComponent(app.id)}/visibility`, {
      body: { json: body },
      what: `sharing ${app.name}`,
    });
    const url = `${box.url}/a/${app.id}/`;
    if (ctx.json) {
      ctx.printJson({ ...shared, url });
      return;
    }
    ctx.out(`${url}\n`);
    if (shared.passcode) ctx.out(`passcode  ${shared.passcode}\n`);
    ctx.err(`${safeText(app.name)} is ${safeText(sharing(shared, ctx.now()))}${shared.passcode ? "; the passcode is shown only this once" : ""}.\n`);
  },
});

const unshare = command({
  path: ["apps", "unshare"],
  summary: "make an app private again, cutting off anyone still connected",
  usage: "<app>",
  operands: { min: 1, max: 1 },
  async run(ctx, p) {
    const { client } = await ctx.connect();
    const app = await findApp(client, p.operands[0] as string);
    await client.json("DELETE", `/_gate/apps/${encodeURIComponent(app.id)}/visibility`, { what: `unsharing ${app.name}` });
    ctx.err(`${safeText(app.name)} is private.\n`);
  },
});

const forwardApp = command({
  path: ["apps", "forward"],
  summary: "an app at localhost here, over a tunnel (full fidelity)",
  usage: "<app> [local-port]",
  operands: { min: 1, max: 2 },
  json: true,
  ownsInterrupt: true,
  async run(ctx: Context, p) {
    const { client } = await ctx.connect();
    const app = await findApp(client, p.operands[0] as string);
    const local = p.operands[1];
    return runForward(ctx, [parseForwardSpec(local ? `${app.port}:${local}` : String(app.port))]);
  },
});

export const APPS_COMMANDS: Command[] = [ls, open, share, unshare, forwardApp];
