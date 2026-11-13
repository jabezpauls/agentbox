/**
 * The CLI's version: the package's, stamped in by the bundler (scripts/build.mjs).
 * It moves in step with the gate's (a test holds them equal), because the box
 * serves the CLI it was built with and says which version that is at
 * `/_gate/version`.
 */
declare const __AGENTBOX_CLI_VERSION__: string | undefined;
declare const __AGENTBOX_STANDALONE__: boolean | undefined;

export const VERSION: string = typeof __AGENTBOX_CLI_VERSION__ === "string" ? __AGENTBOX_CLI_VERSION__ : "0.0.0-dev";

/**
 * This is the standalone executable (scripts/build-sea.mjs), carrying its own
 * Node, rather than agentbox.mjs run by an installed one.
 */
export const STANDALONE: boolean = typeof __AGENTBOX_STANDALONE__ === "boolean" && __AGENTBOX_STANDALONE__;

/** The oldest Node the bundle is built for. */
export const MIN_NODE_MAJOR = 20;

export function nodeMajor(version: string = process.versions.node): number {
  return Number(version.split(".")[0]);
}
