import { create } from "zustand";
import { http } from "../api/http.ts";

/** `GET /_gate/session` for a browser session. */
export interface GateSession {
  kind: "session" | "token";
  id: string;
  user: string;
  createdAt: number;
  remember?: boolean;
  expiresAt?: number;
  twoFactor?: boolean;
}

/** Who is signed in, for Home's greeting and Settings. */
export const useGateSession = create<{ session: GateSession | null; refresh(): Promise<void> }>((set) => ({
  session: null,
  async refresh() {
    try {
      set({ session: await http.get<GateSession>("/_gate/session") });
    } catch {
      // The session guard handles a session that has ended.
    }
  },
}));

/** End this session and go to the sign-in page. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/_gate/logout", { method: "POST" });
  } finally {
    window.location.assign("/login");
  }
}
