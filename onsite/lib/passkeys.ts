/**
 * Face ID / fingerprint sign-in (passkeys, WebAuthn) — the server half, with no opinion about cookies or redirects
 * (actions/passkeys.ts does those, the same way actions/auth.ts does for text codes). README → "Face ID /
 * fingerprint sign-in (passkeys)".
 *
 * The relying party is the site's own address: rpID is the hostname of NEXT_PUBLIC_BASE_URL (overridable with
 * WEBAUTHN_RP_ID) and the only origin accepted is that URL's origin. A passkey is bound to its rpID for good —
 * moving the site to another domain strands every passkey, and people fall back to a text code.
 */
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { sql } from "./db";
import { PASSKEY_OFFER_COOKIE, type PasskeyReason } from "./passkeyClient";

export type Env = Record<string, string | undefined>;
export type RelyingParty = { rpID: string; origin: string; rpName: string };

export const RP_NAME = "OnSite";
export const CHALLENGE_MINUTES = 5;

/** Hourly limits. Login counts per connection (nobody is known yet); registration per person. */
export const PASSKEY_LIMITS = {
  loginOptionsPerIp: 60,
  loginVerifiesPerIp: 60,
  /** Options are fetched as soon as the button is on screen (so the prompt opens inside the tap) — looser. */
  registerOptionsPerUser: 60,
  registersPerUser: 20,
} as const;

/** ES256 first: what iCloud Keychain, Google Password Manager and Windows Hello make. Same list to create and to check. */
export const ALGORITHMS = [-7, -8, -257];

/**
 * Who we are to the browser, or null — and null means no passkey UI anywhere and every passkey action refuses.
 * Off when the base URL is missing, unreadable, or not https (plain http is allowed only under `next dev`), and when
 * an override isn't the URL's host or a parent domain of it (the browser would refuse it anyway).
 */
export function relyingParty(env: Env = process.env): RelyingParty | null {
  const raw = env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const dev = env.NODE_ENV === "development";
  if (url.protocol !== "https:" && !(dev && url.protocol === "http:")) return null;
  const host = url.hostname.toLowerCase();
  const rpID = (env.WEBAUTHN_RP_ID?.trim() || host).toLowerCase();
  if (!rpID || (host !== rpID && !host.endsWith(`.${rpID}`))) return null;
  return { rpID, origin: url.origin, rpName: RP_NAME };
}

/** "04•• ••• 101" for an Australian mobile, "•••• 233" for anything else. Never the whole number. */
export function maskedPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return /^614\d{8}$/.test(d) || /^04\d{8}$/.test(d) ? `04•• ••• ${d.slice(-3)}` : `•••• ${d.slice(-3)}`;
}

/**
 * The account name a phone's passkey list shows: "Batbayar · 04•• ••• 101". A name that has the phone number typed
 * into it is left out, so the full number never reaches a password manager.
 */
export function passkeyUserName(u: { name: string | null; phone: string }): string {
  const name = safeName(u);
  return name ? `${name} · ${maskedPhone(u.phone)}` : maskedPhone(u.phone);
}
/** The name alone, for the passkey's display name — or the masked number when there is no usable name. */
export const passkeyDisplayName = (u: { name: string | null; phone: string }) => safeName(u) ?? maskedPhone(u.phone);

function safeName(u: { name: string | null; phone: string }): string | null {
  const name = u.name?.trim().slice(0, 60);
  const local = u.phone.replace(/\D/g, "").slice(-9);
  return name && !(local.length >= 6 && name.replace(/\D/g, "").includes(local)) ? name : null;
}

/** A stable, opaque id for the person inside their passkey: the 16 bytes of their random users.id. Never the phone. */
export const userHandle = (userId: string) => new Uint8Array(Buffer.from(userId.replace(/-/g, ""), "hex"));
export const userHandleB64 = (userId: string) => Buffer.from(userHandle(userId)).toString("base64url");

/** What Me calls the device, from its user agent. An iPad asks for the desktop site, so its touch screen gives it away. */
export function deviceLabel(ua: string, hints: { touch?: boolean } = {}): string {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && hints.touch)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux computer";
  return "Phone or computer";
}

/**
 * After a code sign-in (and onboarding), the next boss or worker screen asks once: "Sign in with Face ID next
 * time?" This cookie is that "once" — readable by the page, cleared by it (components/PasskeyOffer.tsx).
 */
export async function offerPasskeyNextScreen() {
  if (!relyingParty()) return;
  try {
    (await cookies()).set({ name: PASSKEY_OFFER_COOKIE, value: "1", path: "/", maxAge: 60 * 60, sameSite: "lax", httpOnly: false, secure: process.env.NODE_ENV === "production" });
  } catch { /* outside a request (scripts, tests) */ }
}

export type PasskeyRow = { id: string; credential_id: string; label: string; created_at: Date; last_used_at: Date | null };

/** Someone's passkeys, oldest first, for Me. Nothing secret in it: the public key stays in the database. */
export const listPasskeys = (userId: string) => sql<PasskeyRow[]>`
  SELECT id, credential_id, label, created_at, last_used_at FROM passkeys WHERE user_id = ${userId} ORDER BY created_at`;

// ------------------------------------------------------------------ challenges

const b64url = (v: unknown, max = 2048): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

async function storeChallenge(kind: "register" | "login", userId: string | null, challenge: string) {
  // One statement: expired rows are swept on the way in, so the table never outgrows five minutes of traffic.
  await sql`
    WITH swept AS (DELETE FROM webauthn_challenges WHERE expires_at < now())
    INSERT INTO webauthn_challenges (user_id, kind, challenge, expires_at)
    VALUES (${userId}, ${kind}, ${challenge}, now() + make_interval(mins => ${CHALLENGE_MINUTES}))`;
}

/** Spend a challenge: true exactly once, and only while it is live, of this kind, and (for registration) this person's. */
async function spendChallenge(kind: "register" | "login", userId: string | null, challenge: string): Promise<boolean> {
  const rows = userId
    ? await sql`DELETE FROM webauthn_challenges WHERE challenge = ${challenge} AND kind = ${kind} AND user_id = ${userId} AND expires_at > now() RETURNING 1`
    : await sql`DELETE FROM webauthn_challenges WHERE challenge = ${challenge} AND kind = ${kind} AND user_id IS NULL AND expires_at > now() RETURNING 1`;
  return rows.length === 1;
}

/** The challenge the browser signed, read out of clientDataJSON — the full check of that JSON is the library's. */
function signedChallenge(response: unknown): string | null {
  const data = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (!b64url(data, 8192)) return null;
  try {
    const c = JSON.parse(Buffer.from(data, "base64url").toString("utf8"))?.challenge;
    return b64url(c, 200) ? c : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ registration (signed in)

export async function registrationOptions(rp: RelyingParty, user: { id: string; name: string | null; phone: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await sql<{ credential_id: string; transports: string[] }[]>`
    SELECT credential_id, transports FROM passkeys WHERE user_id = ${user.id}`;
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: userHandle(user.id),
    userName: passkeyUserName(user),
    userDisplayName: passkeyDisplayName(user),
    challenge: new Uint8Array(randomBytes(32)),
    timeout: CHALLENGE_MINUTES * 60 * 1000,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    preferredAuthenticatorType: "localDevice",                   // "Add this phone": this phone's own authenticator
    supportedAlgorithmIDs: ALGORITHMS,
  });
  await storeChallenge("register", user.id, options.challenge);
  return options;
}

const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export type RegisterResult = { ok: true; id: string; credentialId: string } | { ok: false; reason: PasskeyReason };

export async function verifyRegistration(rp: RelyingParty, userId: string, response: unknown, label: string): Promise<RegisterResult> {
  const challenge = signedChallenge(response);
  if (!challenge || !(await spendChallenge("register", userId, challenge))) return { ok: false, reason: "expired" };
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!v.verified) return { ok: false, reason: "failed" };
    info = v.registrationInfo;
  } catch {
    return { ok: false, reason: "failed" };
  }
  const { credential, credentialDeviceType, credentialBackedUp } = info;
  if (!b64url(credential.id, 1024)) return { ok: false, reason: "failed" };
  const transports = (credential.transports ?? []).filter((t) => TRANSPORTS.has(t));
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
    VALUES (${userId}, ${credential.id}, ${Buffer.from(credential.publicKey)}, ${credential.counter}, ${transports},
            ${credentialDeviceType}, ${credentialBackedUp}, ${label.slice(0, 40)})
    ON CONFLICT (credential_id) DO NOTHING
    RETURNING id`;
  if (!row) return { ok: false, reason: "failed" };                 // already on file — for anyone
  return { ok: true, id: row.id, credentialId: credential.id };
}

// ------------------------------------------------------------------ sign-in (nobody yet)

/** Usernameless: no allow-list, so the phone offers whichever OnSite passkeys it holds. */
export async function authenticationOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
    timeout: CHALLENGE_MINUTES * 60 * 1000,
    challenge: new Uint8Array(randomBytes(32)),
  });
  await storeChallenge("login", null, options.challenge);
  return options;
}

export type LoginResult =
  | { ok: true; userId: string; role: string | null; name: string | null }
  | { ok: false; reason: Extract<PasskeyReason, "expired" | "unknown" | "failed"> };

export async function verifyLogin(rp: RelyingParty, response: unknown): Promise<LoginResult> {
  const challenge = signedChallenge(response);
  if (!challenge || !(await spendChallenge("login", null, challenge))) return { ok: false, reason: "expired" };
  const r = response as AuthenticationResponseJSON;
  if (!b64url(r.id, 1024)) return { ok: false, reason: "failed" };

  const [p] = await sql<{ id: string; user_id: string; public_key: Buffer; counter: string; transports: string[] }[]>`
    SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE credential_id = ${r.id}`;
  if (!p) return { ok: false, reason: "unknown" };
  // The phone also says whose passkey it is. It has to be the person this credential was registered to.
  if (r.response?.userHandle && r.response.userHandle !== userHandleB64(p.user_id)) return { ok: false, reason: "failed" };

  let info;
  try {
    const v = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: r.id, publicKey: new Uint8Array(p.public_key), counter: Number(p.counter), transports: p.transports },
      requireUserVerification: true,
    });
    if (!v.verified) return { ok: false, reason: "failed" };
    info = v.authenticationInfo;
  } catch {
    return { ok: false, reason: "failed" };                         // wrong origin or rpID, bad signature, counter went backwards
  }

  // The counter only moves forward — except synced passkeys, which always say 0. Checked again in the write, so two
  // sign-ins racing with the same counter can't both land; the row going away mid-way means it was just removed.
  const n = info.newCounter;
  const [u] = await sql<{ id: string; role: string | null; name: string | null }[]>`
    WITH used AS (
      UPDATE passkeys SET counter = ${n}, last_used_at = now(), backed_up = ${info.credentialBackedUp}, device_type = ${info.credentialDeviceType}
      WHERE id = ${p.id} AND (counter < ${n} OR (counter = 0 AND ${n}::bigint = 0))
      RETURNING user_id
    )
    SELECT u.id, u.role, u.name FROM used JOIN users u ON u.id = used.user_id`;
  if (!u) {
    const [still] = await sql`SELECT 1 FROM passkeys WHERE id = ${p.id}`;
    return { ok: false, reason: still ? "failed" : "unknown" };
  }
  return { ok: true, userId: u.id, role: u.role, name: u.name };
}
