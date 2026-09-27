import fs from "node:fs";
import os from "node:os";
import { bool, int } from "../args.js";
import type { Context } from "../context.js";
import { DavFront, REMOTE_PREFIX } from "../dav.js";
import { CliError, EXIT } from "../errors.js";
import { apiErrorFrom } from "../http.js";
import { driveFromNetUse, findOnPath, mountPlan, runStep } from "../mount.js";
import { command, type Command } from "./types.js";

/** Resolves when the command is asked to stop (Ctrl-C, SIGTERM, SIGHUP). */
function stopped(ctx: Context): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.abort.signal.aborted) return resolve();
    ctx.abort.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const mount = command({
  path: ["mount"],
  summary: "the box's workspace as a folder on this machine (WebDAV)",
  usage: "[dir]",
  operands: { min: 0, max: 1 },
  json: true,
  ownsInterrupt: true,
  options: [
    { name: "no-mount", type: "boolean", description: "only serve it, and print the URL for a WebDAV client of your choice" },
    { name: "port", type: "string", value: "n", description: "the local port (default: any free one)" },
  ],
  details:
    "Serves the workspace on 127.0.0.1 behind a random path, carrying this device's token to the box, and\n" +
    "mounts it: macOS mount_webdav (at [dir], default ~/agentbox/<box>), Linux gio mount ([dir] becomes a\n" +
    "link to it), Windows net use ([dir] is a drive letter, default the next free one). Keep it running;\n" +
    "Ctrl-C unmounts. Deleting sends things to the box's trash.",
  async run(ctx, p) {
    const { name, client } = await ctx.connect();
    // Ask the box first: an old box without WebDAV, or a revoked token, is
    // better said here than as a mount that fails in the file manager.
    const probe = await client.request("PROPFIND", `${REMOTE_PREFIX}/`, { headers: { depth: "0" } });
    probe.discard();
    if (probe.status === 401) throw apiErrorFrom(401, "", "WebDAV");
    if (probe.status === 404) throw new CliError(`${name} does not serve WebDAV yet; update the box`, EXIT.NOT_FOUND);
    if (probe.status !== 207) throw new CliError(`${name} refused WebDAV (HTTP ${probe.status})`);

    const port = int(p.options, "port", 1, 65535);
    const front = new DavFront(client, {
      ...(port ? { port } : {}),
      onUnauthorized: () => ctx.warn("the box refused this device's token; the mount will not work until you `agentbox login` again"),
      onError: (m) => ctx.warn(m),
    });
    let url: string;
    try {
      url = await front.start();
    } catch (err) {
      throw new CliError(`could not listen on 127.0.0.1${port ? `:${port}` : ""}: ${(err as Error).message}`);
    }

    try {
      if (bool(p.options, "no-mount")) {
        if (ctx.json) ctx.printJson({ box: name, url });
        else ctx.out(`${url}\n`);
        ctx.err(`Serving ${name}'s workspace over WebDAV at that URL (loopback only). Ctrl-C to stop.\n`);
        await stopped(ctx);
        return;
      }

      const dir = p.operands[0] ?? null;
      let plan;
      try {
        plan = mountPlan({ platform: ctx.platform, url, port: front.listenPort, secret: front.secret, dir, boxName: name, home: os.homedir(), env: ctx.env });
      } catch (err) {
        throw new CliError((err as Error).message, EXIT.USAGE);
      }
      const helper = findOnPath(plan.helper, ctx.env, ctx.platform);
      if (!helper) {
        throw new CliError(`${plan.helper} was not found, so the box cannot be mounted here: ${plan.install}. Or serve it with \`agentbox mount --no-mount\` and use any WebDAV client.`);
      }

      let madeMountpoint = false;
      if (plan.mountpoint && !fs.existsSync(plan.mountpoint)) {
        fs.mkdirSync(plan.mountpoint, { recursive: true });
        madeMountpoint = true;
      }
      if (plan.link && fs.existsSync(plan.link)) throw new CliError(`${plan.link} already exists; name a new folder for the link, or leave it out`);

      const mounted = await runStep(plan.mount, helper);
      if (mounted.code !== 0) {
        if (madeMountpoint) fs.rmSync(plan.mountpoint as string, { recursive: false, force: true });
        throw new CliError(`${plan.helper} could not mount it${mounted.output ? `: ${mounted.output}` : ""}`);
      }
      let where = plan.where;
      let unmount = plan.unmount;
      if (ctx.platform === "win32" && !where) {
        where = driveFromNetUse(mounted.output);
        if (where) unmount = { command: "net", args: ["use", where, "/delete", "/y"] };
      }
      let linked = false;
      if (plan.link && where) {
        fs.symlinkSync(where, plan.link, "dir");
        linked = true;
      }

      if (ctx.json) ctx.printJson({ box: name, url, mountedAt: linked ? plan.link : where });
      else ctx.out(`Mounted ${name} at ${linked ? `${plan.link} (→ ${where})` : (where ?? "a new drive")}\n`);
      ctx.err("Keep this running while you use it; Ctrl-C unmounts.\n");

      await stopped(ctx);
      ctx.err("Unmounting…\n");
      if (unmount) {
        const done = await runStep(unmount, findOnPath(unmount.command, ctx.env, ctx.platform) ?? unmount.command);
        if (done.code !== 0) ctx.warn(`${unmount.command} ${unmount.args.join(" ")} failed${done.output ? `: ${done.output}` : ""}; unmount it yourself`);
      }
      if (linked) fs.rmSync(plan.link as string, { force: true });
      if (madeMountpoint) {
        try {
          fs.rmdirSync(plan.mountpoint as string);
        } catch {
          // Still busy, or not empty: leave it.
        }
      }
    } finally {
      await front.close();
    }
  },
});

export const MOUNT_COMMANDS: Command[] = [mount];
