// URLs for the preview panel. The bridge proxies `<base>/preview/<port>/…` to
// `127.0.0.1:<port>`; when a preview domain is configured each port also gets
// its own hostname for full-screen viewing.

function stripLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, "");
}

/** The in-app iframe URL: the bridge's port proxy under the base path. */
export function previewUrl(base: string, port: number, path: string): string {
  return `${base}/preview/${port}/${stripLeadingSlashes(path)}`;
}

/**
 * Where "open full screen" points. With a preview domain the port becomes a
 * subdomain (its own origin, so it escapes the proxy path); without one it is
 * the proxied path, opened in a new tab against the current origin.
 */
export function fullScreenUrl(port: number, path: string, previewDomain: string | null, base: string): string {
  if (previewDomain) return `https://${port}.${previewDomain}/${stripLeadingSlashes(path)}`;
  return previewUrl(base, port, path);
}
