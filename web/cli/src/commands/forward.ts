import type net from "node:net";
import { forwardPort, openTunnel, parseForwardSpec } from "../tunnel.js";
import { command, type Command } from "./types.js";

export const forward = command({
  path: ["forward"],
  summary: "a port in the box at localhost here, over a tunnel",
  usage: "<port>[:<local>]…",
  operands: { min: 1, max: Infinity },
  json: true,
  ownsInterrupt: true,
  details:
    "Full fidelity for a dev server: `agentbox forward 5173` serves the box's port 5173 at\n" +
    "http://localhost:5173 here (5173:3000 puts it at local port 3000). Ctrl-C stops.",
  async run(ctx, p) {
    const specs = p.operands.map(parseForwardSpec);
    const { name, client } = await ctx.connect();
    // One tunnel up front, so a box without tunnels, a revoked token or a
    // refused port is said now rather than on the first browser request.
    const probe = await openTunnel(client, { kind: "tcp", port: specs[0]!.remote });
    probe.destroy();

    const servers: net.Server[] = [];
    try {
      for (const spec of specs) {
        servers.push(await forwardPort(client, spec, { onError: (err) => ctx.warn(`port ${spec.remote}: ${err.message}`) }));
      }
      if (ctx.json) ctx.printJson(specs.map((s) => ({ remote: s.remote, local: s.local, url: `http://localhost:${s.local}` })));
      else for (const s of specs) ctx.out(`http://localhost:${s.local}  →  ${name}:${s.remote}\n`);
      ctx.err("Forwarding. Ctrl-C to stop.\n");
      await new Promise<void>((resolve) => {
        if (ctx.abort.signal.aborted) return resolve();
        ctx.abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      for (const s of servers) s.close();
    }
  },
});

export const FORWARD_COMMANDS: Command[] = [forward];
