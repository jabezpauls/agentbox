/** How long a share lasts, as the Share control offers it. `null` is until stopped. */
export interface ExpiryChoice {
  id: string;
  label: string;
  seconds: number | null;
}

export const EXPIRIES: ExpiryChoice[] = [
  { id: "1h", label: "1 hour", seconds: 3600 },
  { id: "1d", label: "1 day", seconds: 86_400 },
  { id: "7d", label: "7 days", seconds: 7 * 86_400 },
  { id: "30d", label: "30 days", seconds: 30 * 86_400 },
  { id: "never", label: "Until I stop it", seconds: null },
];

const KEY = "agentbox.share.expiry";

/** The expiry a new share starts with (Settings → Sharing). */
export function defaultExpiry(): ExpiryChoice {
  try {
    const id = localStorage.getItem(KEY);
    return EXPIRIES.find((e) => e.id === id) ?? EXPIRIES[2]!;
  } catch {
    return EXPIRIES[2]!;
  }
}

export function setDefaultExpiry(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Remembered for this page only.
  }
}
