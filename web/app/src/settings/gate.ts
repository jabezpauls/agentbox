import { http } from "../api/http.ts";

/**
 * The gate's account API (`/_gate/*`). Anything that could lock the owner
 * out or hand the box to someone else wants the password — and a two-factor
 * code, when that is on — in the request itself; nothing is remembered
 * between requests (see docs/security.md).
 */

export interface Credentials {
  password: string;
  code?: string;
}

export interface SessionRow {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  remember: boolean;
  ip: string;
  userAgent: string;
}

export interface TokenRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  lastIp: string | null;
  current: boolean;
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
}

const body = (c: Credentials, extra: Record<string, unknown> = {}) => ({ ...extra, password: c.password, ...(c.code ? { code: c.code } : {}) });

export const gateApi = {
  sessions: () => http.get<SessionRow[]>("/_gate/sessions"),
  endSession: (id: string) => http.del<void>(`/_gate/sessions/${encodeURIComponent(id)}`),
  endOthers: () => http.del<{ ended: number }>("/_gate/sessions?others=1"),
  changePassword: (current: Credentials, next: string) =>
    http.post<{ ok: true; endedSessions: number }>("/_gate/password", { current: current.password, next, ...(current.code ? { code: current.code } : {}) }),
  totpSetup: (c: Credentials) => http.post<TotpSetup>("/_gate/totp/setup", body(c)),
  totpConfirm: (password: string, code: string) => http.post<{ recoveryCodes: string[] }>("/_gate/totp/confirm", { password, code }),
  totpDisable: (c: Credentials) => http.del<void>("/_gate/totp", body(c)),
  tokens: () => http.get<TokenRow[]>("/_gate/tokens"),
  revokeToken: (id: string, c: Credentials) => http.del<void>(`/_gate/tokens/${encodeURIComponent(id)}`, body(c)),
  version: () => http.get<{ version: string }>("/_gate/version"),
};

/** "Chrome on macOS", from a User-Agent, for the sessions list. */
export function describeAgent(ua: string): string {
  if (!ua) return "Unknown browser";
  if (/agentbox\//i.test(ua)) return "agentbox CLI";
  if (/^curl\//i.test(ua)) return "curl";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} on ${os}` : browser;
}
