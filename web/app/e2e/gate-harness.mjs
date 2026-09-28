#!/usr/bin/env node
// The gate for the end-to-end stack: the real gate build, started as main.js
// starts it, with one difference — a higher ceiling on sign-in attempts across
// all addresses. The suite signs in for real dozens of times, and more when it
// is repeated on one stack (`--repeat-each`), which would otherwise spend the
// production ceiling of thirty a minute and turn later sign-ins away as busy.
// Every per-address limit (the pause, the lockout) stays as shipped; the
// login spec proves them. Test-only: production runs main.js.
import path from "node:path";
import { fileURLToPath } from "node:url";

const gateDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../gate/dist");
const { buildGate } = await import(path.join(gateDist, "app.js"));
const { loadConfig } = await import(path.join(gateDist, "config.js"));
const { LOGIN_LIMITS } = await import(path.join(gateDist, "ratelimit.js"));

process.umask(0o077);
const config = loadConfig();
const gate = await buildGate(config, { limits: { ...LOGIN_LIMITS, globalPerWindow: 10_000 } });
await gate.app.listen({ host: config.host, port: config.port });
await new Promise((resolve, reject) => {
  gate.sandboxServer.once("error", reject);
  gate.sandboxServer.listen(config.appsPort, config.appsHost, resolve);
});
console.log(`[gate] (e2e harness) listening on ${config.host}:${config.port}`);
const stop = () => void gate.close().finally(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
