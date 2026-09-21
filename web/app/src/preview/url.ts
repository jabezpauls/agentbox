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
 * Where a preview is actually loaded from — both the panel's iframe and "open
 * full screen". With a preview domain the port becomes a subdomain, which is a
 * separate origin: the page gets its cookies and storage back and the iframe
 * needs no sandbox. Without one it is the bridge's proxied path on this origin.
 */
export function previewTarget(port: number, path: string, previewDomain: string | null, base: string): string {
  if (previewDomain) return `https://${port}.${previewDomain}/${stripLeadingSlashes(path)}`;
  return previewUrl(base, port, path);
}
