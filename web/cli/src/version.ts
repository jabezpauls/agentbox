/**
 * The CLI's version: the package's, stamped in by the bundler (scripts/build.mjs).
 * It moves in step with the gate's (a test holds them equal), because the box
 * serves the CLI it was built with and says which version that is at
 * `/_gate/version`.
 */
declare const __AGENTBOX_CLI_VERSION__: string | undefined;

export const VERSION: string = typeof __AGENTBOX_CLI_VERSION__ === "string" ? __AGENTBOX_CLI_VERSION__ : "0.0.0-dev";

/** The oldest Node the bundle is built for. */
export const MIN_NODE_MAJOR = 20;

export function nodeMajor(version: string = process.versions.node): number {
  return Number(version.split(".")[0]);
}
