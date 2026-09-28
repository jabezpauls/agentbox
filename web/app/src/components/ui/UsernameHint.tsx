import { useGateSession } from "../../shell/session.ts";

/**
 * The account a password belongs to, for password managers: a form with a
 * password field but no username is one they cannot save or fill properly.
 * Hidden — it is not something to type.
 */
export function UsernameHint() {
  const user = useGateSession((s) => s.session?.user ?? "");
  return <input type="text" name="username" autoComplete="username" value={user} readOnly hidden tabIndex={-1} aria-hidden="true" />;
}
