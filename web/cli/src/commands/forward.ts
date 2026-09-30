import type net from "node:net";
import type { Context } from "../context.js";
import { forwardPort, openTunnel, parseForwardSpec, type ForwardSpec } from "../tunnel.js";
import { command, type Command } from "./types.js";

/** agentbox's own services in the box, by port: forwarding one hands it to this machine without the gate in front. */
export const BOX_SERVICES: Record<number, string> = {
  8080: "the editor (code-server)",
  7681: "herdr's TUI (ttyd)",
  7682: "the process monitor (ttyd)",
  7683: "a shell (ttyd)",
  2222: "the box's sshd (key-only)",
  7800: "the Workbench's API (the bridge)",
  7801: "the bridge's app plane",
  7900: "the gate",
  7901: "the gate's sandbox side",
};

/** Warn about agentbox's own ports, open one tunnel to check, then serve every spec until Ctrl-C. */
export async function runForward(ctx: Context, specs: ForwardSpec[]): Promise<void> {
  for (const s of specs) {
    const what = BOX_SERVICES[s.remote];
    if (what) {
      ctx.warn(
        `port ${s.remote} is ${what} in the box, reached through the tunnel as this device, without the box's sign-in: ` +
          `while this runs, anyone on this machine — and a web page, by DNS rebinding — can use it at 127.0.0.1:${s.local}`,
      );
    }
  }
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
}

export const forward = command({
  path: ["forward"],
  summary: "a port in the box at localhost here, over a tunnel",
  usage: "<port>[:<local>]…",
  operands: { min: 1, max: Infinity },
  json: true,
  ownsInterrupt: true,
  details:
    "Full fidelity for a dev server: `agentbox forward 5173` serves the box's port 5173 at\n" +
    "http://localhost:5173 here (5173:3000 puts it at local port 3000). Ctrl-C stops. It listens on\n" +
    "127.0.0.1 only, but there without the box's sign-in: anyone on this machine can use it meanwhile.",
  async run(ctx, p) {
    return runForward(ctx, p.operands.map(parseForwardSpec));
  },
});

export const FORWARD_COMMANDS: Command[] = [forward];
