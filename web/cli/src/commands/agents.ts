import type { ReviewSession, SessionSnapshot } from "@workbench/shared";
import { bool } from "../args.js";
import { openBrowser } from "../browser.js";
import { CliError, EXIT } from "../errors.js";
import { safeText, table } from "../format.js";
import { agentRows } from "./status.js";
import { command, type Command } from "./types.js";

const t = (v: unknown): string => safeText(String(v));

const agentsLs = command({
  path: ["agents", "ls"],
  summary: "the agents running in the box, and what they are doing",
  usage: "",
  json: true,
  async run(ctx) {
    const { client } = await ctx.connect();
    const rows = agentRows(await client.json<SessionSnapshot>("GET", "/api/session", { what: "reading agents" }));
    if (ctx.json) {
      ctx.printJson(rows);
      return;
    }
    if (rows.length === 0) {
      ctx.err("No agents are running.\n");
      return;
    }
    ctx.out(table(["AGENT", "STATUS", "WORKSPACE", "PANE", "WHERE"], rows.map((a) => [t(a.agent), t(a.status), t(a.workspace), t(a.paneId), t(a.cwd ?? "-")])));
  },
});

const reviewLs = command({
  path: ["review", "ls"],
  summary: "pages agents have published for your review",
  usage: "",
  json: true,
  async run(ctx) {
    const { client } = await ctx.connect();
    const sessions = await client.json<ReviewSession[]>("GET", "/api/review/sessions", { what: "reading reviews" });
    if (ctx.json) {
      ctx.printJson(sessions);
      return;
    }
    if (sessions.length === 0) {
      ctx.err("Nothing awaits your review.\n");
      return;
    }
    ctx.out(table(["KEY", "STATUS", "PENDING", "UPDATED", "LABEL"], sessions.map((s) => [t(s.key), t(s.status), t(s.pending), t(s.updated), t(s.label)])));
  },
});

const reviewOpen = command({
  path: ["review", "open"],
  summary: "open a review in your browser",
  usage: "<key>",
  operands: { min: 1, max: 1 },
  options: [{ name: "print", type: "boolean", description: "print the URL instead of opening it" }],
  async run(ctx, p) {
    const { box, client } = await ctx.connect();
    const key = p.operands[0] as string;
    const sessions = await client.json<ReviewSession[]>("GET", "/api/review/sessions", { what: "reading reviews" });
    if (!sessions.some((s) => s.key === key)) throw new CliError(`no review "${key}" (see \`agentbox review ls\`)`, EXIT.NOT_FOUND);
    const url = `${box.url}/workbench?review=${encodeURIComponent(key)}`;
    if (bool(p.options, "print") || !(await openBrowser(url, ctx.platform, ctx.env))) ctx.out(`${url}\n`);
    else ctx.err(`Opened ${url}\n`);
  },
});

export const AGENT_COMMANDS: Command[] = [agentsLs, reviewLs, reviewOpen];
