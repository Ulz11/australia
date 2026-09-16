import { sql } from "./db";
import { OTP, codeMatches } from "./otp";
import { hit } from "./ratelimit";

/**
 * Checking a login code, with no opinion about cookies or redirects.
 *
 * Both the web form and the mobile API go through here, so the hardening — one guess
 * spent per attempt, counted in the same statement that checks it; a code that signs
 * in exactly once — cannot drift apart between the two.
 */
export type OtpResult =
  | { ok: true; userId: string; role: string | null; name: string | null }
  /** `step` says where the caller should send them back to: the number, or the code box. */
  | { ok: false; step: "phone" | "code"; error: string };

export async function verifyOtp(phone: string, code: string, ip: string | null): Promise<OtpResult> {
  if (ip && !(await hit(`otp-verify:ip:${ip}`, OTP.verifiesPerIpPerHour, 3600)))
    return { ok: false, step: "code", error: "Too many tries from this connection. Try again in an hour." };

  // Spend the guess before checking it, in one statement: parallel guesses can't all see "attempts < 5".
  const [row] = await sql<{ code: string }[]>`
    UPDATE otp_codes SET attempts = attempts + 1
    WHERE phone = ${phone} AND expires_at > now() AND attempts < ${OTP.wrongPerHour}
    RETURNING code`;
  if (!row) {
    const [o] = await sql`SELECT attempts, expires_at > now() AS live FROM otp_codes WHERE phone = ${phone}`;
    return {
      ok: false,
      step: "phone",
      error:
        o?.live && o.attempts >= OTP.wrongPerHour
          ? "Too many wrong codes. Try again in an hour."
          : "Code expired. Try again.",
    };
  }
  if (!codeMatches(phone, code, row.code)) return { ok: false, step: "code", error: "Wrong code" };

  // A code signs in once. The row stays (spent), so the per-number send limits still hold after a sign-in.
  const [used] = await sql`UPDATE otp_codes SET code = 'spent', expires_at = now()
                           WHERE phone = ${phone} AND code = ${row.code} AND expires_at > now() RETURNING 1`;
  if (!used) return { ok: false, step: "phone", error: "Code expired. Try again." };

  // One statement: the account, and — on a closed-beta invite's first sign-in — the stamp saying the invite was used.
  const [user] = await sql`
    WITH u AS (
      INSERT INTO users (phone) VALUES (${phone})
      ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
      RETURNING id, role, name
    ), invited AS (
      UPDATE beta_invites SET first_signed_in_at = now() WHERE phone = ${phone} AND first_signed_in_at IS NULL
    )
    SELECT id, role, name FROM u`;
  return { ok: true, userId: user.id, role: user.role, name: user.name };
}
