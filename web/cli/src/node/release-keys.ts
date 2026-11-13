/**
 * The public keys a machine's node trusts for updates: each an ed25519 public
 * key in PEM (SPKI), as `openssl pkey -pubout` prints it. Two at most — the
 * key releases are signed with now, and the next one — so the key can be
 * rotated without the node trusting anything it did not ship with
 * (RELEASING.md, "Signing machines releases").
 *
 * Empty, the node cannot verify a release and refuses every update.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  // current
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQP6eEvWwcx5ptR56iFAJvDISpDYvy2oWOYNTH9KMUzw=
-----END PUBLIC KEY-----`,
  // next (rotation)
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANhmTV3Z/SVIUjCBjFrK+nZpl3Y2ck7vRex7l5CixSDU=
-----END PUBLIC KEY-----`,
];
