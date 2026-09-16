import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Login codes. Rules that keep a 6-digit code from being guessed:
 *  - codes come from the crypto RNG, never Math.random
 *  - only an HMAC of (phone, code) is stored, so a database read doesn't hand out live codes
 *  - five wrong guesses per number per hour, counted atomically and NOT reset by asking for a new code
 * Limits live here so the action and the tests agree on them.
 */
export const OTP = {
  ttlMinutes: 10,
  resendSeconds: 60,
  sendsPerHour: 5,
  wrongPerHour: 5,
  // A site hotspot or carrier NAT is one address for a whole crew, so these sit well above a plausible crew size.
  // The precision comes from the per-number limits above; these only stop one connection running away.
  sendsPerIpPerHour: 40,
  verifiesPerIpPerHour: 150,
  /** Codes the whole app may send in an hour — a cost ceiling, not a lock: refused requests don't count. */
  sendsPerHourAll: () => Number(process.env.OTP_SENDS_PER_HOUR) || 1000,
} as const;

export const newCode = () => String(randomInt(100000, 1000000));

const key = () => {
  const s = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!s || s.length < 32))
    throw new Error("SESSION_SECRET must be set to a random string of 32+ characters in production");
  return s || "dev-secret-change-me";
};

export const hashCode = (phone: string, code: string) =>
  createHmac("sha256", key()).update(`otp:${phone}:${code}`).digest("hex");

export function codeMatches(phone: string, code: string, stored: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hashCode(phone, code)), b = Buffer.from(String(stored));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Australian mobiles only, unless ALLOW_INTL_PHONES=1 (testing). Foreign numbers are how SMS bills get pumped. */
export const phoneAllowed = (e164: string) => /^\+614\d{8}$/.test(e164) || process.env.ALLOW_INTL_PHONES === "1";

/** Invite codes: 6 characters from the crypto RNG (A–Z, 0–9). */
export const inviteCode = () => Array.from({ length: 6 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[randomInt(36)]).join("");
