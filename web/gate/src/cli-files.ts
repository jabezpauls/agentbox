/**
 * The CLI, served by the box itself: `/cli/agentbox.mjs` (the bundle) and
 * `/cli/install` (the script `curl … | sh` runs), both open-source files baked
 * into the gate's image. They are the only `/cli` paths, and the only ones
 * served without a session or token besides sign-in: exactly these two, by
 * the route table.
 *
 * The install script ends by signing in to the box it came from, so the box
 * writes its own origin into it. That origin comes from the configuration or
 * the request's Host, and is only ever written as a plain
 * `scheme://host[:port]` between single quotes, where nothing is special to
 * the shell.
 */

export const INSTALL_NAME = "install";
export const BUNDLE_NAME = "agentbox.mjs";
export const INSTALL_PLACEHOLDER = "@@AGENTBOX_URL@@";

const PLAIN_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** The script with this box's origin in it, or `null` when the origin is not one to put there. */
export function renderInstallScript(template: string, origin: string): string | null {
  if (!PLAIN_ORIGIN.test(origin) || !template.includes(INSTALL_PLACEHOLDER)) return null;
  return template.split(INSTALL_PLACEHOLDER).join(origin);
}
