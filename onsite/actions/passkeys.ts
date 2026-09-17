"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { sql } from "@/lib/db";
import { createSession, getUser, signedInPath } from "@/lib/session";
import { clientIp, hit } from "@/lib/ratelimit";
import { revalidatePath } from "@/lib/nav";
import { isUuid } from "@/lib/validate";
import { PASSKEY_WORDS, type PasskeyReason } from "@/lib/passkeyClient";
import {
  PASSKEY_LIMITS, authenticationOptions, deviceLabel, registrationOptions, relyingParty, verifyLogin, verifyRegistration,
} from "@/lib/passkeys";

/**
 * Face ID / fingerprint sign-in for the web app (lib/passkeys.ts does the checking). Server actions rather than
 * routes: they post to the page they're on, so the control room's path-scoped frame cookies work too, Next checks
 * the Origin for us, and Remove is a ConfirmButton like every other "are you sure" in the app.
 *
 * Every action refuses when passkeys are off (lib/passkeys.ts relyingParty); registering and removing check who is
 * calling before anything else (tests/unit/routeGuards.test.ts).
 */
type Refusal = { ok: false; reason: PasskeyReason; error: string };
const refuse = (reason: PasskeyReason): Refusal => ({ ok: false, reason, error: PASSKEY_WORDS[reason] });
const NOT_SIGNED_IN = { ok: false, reason: "off", error: "Sign in first." } as const satisfies Refusal;

// ------------------------------------------------------------------ sign-in: nobody is known yet, so limits are per connection

export async function passkeyLoginOptions(): Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON } | Refusal> {
  const rp = relyingParty();
  if (!rp) return refuse("off");
  const ip = await clientIp();
  if (ip && !(await hit(`passkey-login:ip:${ip}`, PASSKEY_LIMITS.loginOptionsPerIp, 3600))) return refuse("busy");
  return { ok: true, options: await authenticationOptions(rp) };
}

/** Signs in exactly as a text code does (actions/auth.ts verifyCode): the same session cookie, the same redirect. */
export async function passkeySignIn(response: unknown, invite?: string): Promise<Refusal> {
  const rp = relyingParty();
  if (!rp) return refuse("off");
  const ip = await clientIp();
  if (ip && !(await hit(`passkey-verify:ip:${ip}`, PASSKEY_LIMITS.loginVerifiesPerIp, 3600))) return refuse("busy");
  const r = await verifyLogin(rp, response);
  if (!r.ok) return refuse(r.reason);
  await createSession(r.userId);
  redirect(signedInPath(r, typeof invite === "string" ? invite.trim().slice(0, 20) : ""));
}

// ------------------------------------------------------------------ this person's passkeys

export async function passkeyRegisterOptions(): Promise<{ ok: true; options: PublicKeyCredentialCreationOptionsJSON } | Refusal> {
  const u = await getUser();
  if (!u) return NOT_SIGNED_IN;
  const rp = relyingParty();
  if (!rp) return refuse("off");
  if (!(await hit(`passkey-register-options:${u.id}`, PASSKEY_LIMITS.registerOptionsPerUser, 3600))) return refuse("busy");
  const [me] = await sql<{ id: string; name: string | null; phone: string }[]>`SELECT id, name, phone FROM users WHERE id = ${u.id}`;
  if (!me) return NOT_SIGNED_IN;
  return { ok: true, options: await registrationOptions(rp, me) };
}

/** `device.touch`: a "Mac" with a touch screen is an iPad (lib/passkeys.ts deviceLabel). */
export async function passkeyRegister(response: unknown, device?: { touch?: boolean }): Promise<{ ok: true; credentialId: string } | Refusal> {
  const u = await getUser();
  if (!u) return NOT_SIGNED_IN;
  const rp = relyingParty();
  if (!rp) return refuse("off");
  if (!(await hit(`passkey-register:${u.id}`, PASSKEY_LIMITS.registersPerUser, 3600))) return refuse("busy");
  const label = deviceLabel((await headers()).get("user-agent") ?? "", { touch: device?.touch === true });
  const r = await verifyRegistration(rp, u.id, response, label);
  if (!r.ok) return refuse(r.reason);
  revalidatePath("/boss/me");
  revalidatePath("/worker/me");
  return { ok: true, credentialId: r.credentialId };
}

/** Me → Remove. Only ever one of the caller's own. */
export async function removePasskey(id: string): Promise<void> {
  const u = await getUser();
  if (!u) return;
  if (!isUuid(id)) return;
  await sql`DELETE FROM passkeys WHERE id = ${id} AND user_id = ${u.id}`;
  revalidatePath("/boss/me");
  revalidatePath("/worker/me");
}
