import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bool, int } from "../args.js";
import type { Context } from "../context.js";
import { DavFront, REMOTE_PREFIX } from "../dav.js";
import { CliError, EXIT } from "../errors.js";
import { apiErrorFrom } from "../http.js";
import { driveFromNetUse, findOnPath, gvfsMountName, linkFolderProblem, mountPlan, runStep } from "../mount.js";
import { command, type Command } from "./types.js";

/** This mount's folder under gvfs's, once it appears; `null` after `ms` without it. */
async function gvfsFolder(root: string, port: number, secret: string, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      // Not there (yet).
    }
    const name = gvfsMountName(names, port, secret);
    if (name) return path.join(root, name);
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
    "Serves the workspace on 127.0.0.1 behind a random path and a random password, carrying this device's\n" +
    "token to the box, and mounts it: macOS mount_webdav (at [dir], default ~/agentbox/<box>), Linux gio\n" +
    "mount ([dir] becomes a link to it, in a folder only you can open), Windows net use ([dir] is a drive\n" +
    "letter, default the next free one). Keep it running; Ctrl-C unmounts. Deleting sends things to the\n" +
    "box's trash. --no-mount prints the URL, user and password for a WebDAV client of your choice.",
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
    const noMount = bool(p.options, "no-mount");
    const dir = p.operands[0] ?? null;
    // Windows' WebClient will not send Basic credentials over plain http, so
    // a `net use` mount can only be guarded by the path; any other client can.
    const front = new DavFront(client, {
      ...(ctx.platform === "win32" && !noMount ? { credentials: null } : {}),
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
      const credentials = front.credentials;
      if (noMount) {
        if (ctx.json) ctx.printJson({ box: name, url, user: credentials?.user ?? null, password: credentials?.password ?? null });
        else ctx.out(`${url}\n${credentials ? `user      ${credentials.user}\npassword  ${credentials.password}\n` : ""}`);
        ctx.err(`Serving ${name}'s workspace over WebDAV there (loopback only${credentials ? ", with that user and password" : ""}). Ctrl-C to stop.\n`);
        await stopped(ctx);
        return;
      }

      let plan;
      try {
        plan = mountPlan({ platform: ctx.platform, url, dir, boxName: name, home: os.homedir(), env: ctx.env, credentials });
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
      if (plan.link) {
        if (fs.existsSync(plan.link)) throw new CliError(`${plan.link} already exists; name a new folder for the link, or leave it out`);
        const problem = linkFolderProblem(path.dirname(plan.link));
        if (problem) throw new CliError(problem);
      }

      const mounted = await runStep(plan.mount, helper, ctx.env);
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
      // gvfs shows a mount as a folder only through its FUSE helper, which
      // takes a moment and may not be running at all (a server, a container).
      let gioOnly = false;
      if (plan.gvfsRoot) {
        where = await gvfsFolder(plan.gvfsRoot, front.listenPort, front.secret, 5000);
        if (!where) {
          gioOnly = true;
          const dav = url.replace(/^http:/, "dav:");
          if (ctx.json) ctx.printJson({ box: name, url, mountedAt: null, gio: dav });
          else ctx.out(`Mounted ${name} in gvfs as ${dav}: open that in your file manager (gvfs's folder view, gvfsd-fuse, is not running here)\n`);
        }
      }
      let linked = false;
      if (plan.link && where) {
        fs.symlinkSync(where, plan.link, "dir");
        linked = true;
      }

      if (!gioOnly) {
        if (ctx.json) ctx.printJson({ box: name, url, mountedAt: linked ? plan.link : where });
        else ctx.out(`Mounted ${name} at ${linked ? `${plan.link} (→ ${where})` : (where ?? "a new drive")}\n`);
      }
      ctx.err("Keep this running while you use it; Ctrl-C unmounts.\n");

      await stopped(ctx);
      ctx.err("Unmounting…\n");
      if (unmount) {
        const done = await runStep(unmount, findOnPath(unmount.command, ctx.env, ctx.platform) ?? unmount.command, ctx.env);
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
