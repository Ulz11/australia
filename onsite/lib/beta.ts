import { sql } from "./db";
import { normalisePhone } from "./sms";
import { phoneAllowed } from "./otp";

/**
 * The closed beta's guest list.
 *
 * With BETA_INVITE_ONLY=1 a login code is only sent to a number that is on `beta_invites` or already
 * belongs to an account. Anyone else gets BETA_REFUSAL and nothing else: no text, no code row, nothing
 * from the app-wide or per-number send budgets. The refusal still costs their connection one of its
 * hourly code requests, so the gate can't be used to test which numbers are invited for free.
 *
 * The gate lives in requestCode (actions/auth.ts), which the web form and POST /api/v1/auth/request-code
 * both call, so the two can't drift apart.
 */
export const BETA_REFUSAL = "OnSite is in a closed beta — ask the person who invited you to add this number.";

/** Read per request, so flipping the variable needs no rebuild. */
export const betaInviteOnly = () => process.env.BETA_INVITE_ONLY === "1";

/** On the guest list, or already has an account. */
export async function mayRequestCode(phone: string): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM beta_invites WHERE phone = ${phone})
        OR EXISTS (SELECT 1 FROM users WHERE phone = ${phone}) AS ok`;
  return !!r?.ok;
}

export type InviteRole = "boss" | "worker";
export type Invite = { phone: string; role: InviteRole | null; note: string | null; invited_at: Date; first_signed_in_at: Date | null; has_account: boolean };

/** The same rules as the login form: an Australian mobile, in E.164. */
export function inviteePhone(raw: string): string | null {
  const phone = normalisePhone(raw);
  return phone && phoneAllowed(phone) ? phone : null;
}

/** Add a number, or update its role/note. A role or note left out keeps what was there. */
export async function invite(raw: string, opts: { role?: InviteRole | null; note?: string | null } = {}): Promise<Invite> {
  const phone = inviteePhone(raw);
  if (!phone) throw new Error("Not an Australian mobile number (e.g. 0412 345 678).");
  const role = opts.role ?? null;
  if (role !== null && role !== "boss" && role !== "worker") throw new Error("--role must be worker or boss.");
  const note = opts.note?.trim().slice(0, 200) || null;
  await sql`
    INSERT INTO beta_invites (phone, role, note) VALUES (${phone}, ${role}, ${note})
    ON CONFLICT (phone) DO UPDATE SET role = COALESCE(EXCLUDED.role, beta_invites.role), note = COALESCE(EXCLUDED.note, beta_invites.note)`;
  return (await listInvites(phone))[0];
}

export async function listInvites(onlyPhone?: string): Promise<Invite[]> {
  return sql<Invite[]>`
    SELECT b.phone, b.role, b.note, b.invited_at, b.first_signed_in_at, (u.id IS NOT NULL) AS has_account
    FROM beta_invites b LEFT JOIN users u ON u.phone = b.phone
    ${onlyPhone ? sql`WHERE b.phone = ${onlyPhone}` : sql``}
    ORDER BY b.invited_at, b.phone`;
}

/** Take a number off the list. Returns false when it wasn't on it. An existing account can still sign in. */
export async function uninvite(raw: string): Promise<boolean> {
  const phone = inviteePhone(raw);
  if (!phone) throw new Error("Not an Australian mobile number (e.g. 0412 345 678).");
  const gone = await sql`DELETE FROM beta_invites WHERE phone = ${phone}`;
  return gone.count > 0;
}
