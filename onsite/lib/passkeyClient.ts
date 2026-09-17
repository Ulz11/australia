/**
 * The browser half of Face ID / fingerprint sign-in (passkeys): what this phone can do, what it remembers, and the
 * plain words for every way a ceremony can end. Client-safe — no database, no secrets. The server half is
 * lib/passkeys.ts.
 */
import { browserSupportsPasskeys, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, platformAuthenticatorIsAvailable } from "@simplewebauthn/browser";

/** Set by a code sign-in and by onboarding; the boss and worker layouts show the "next time?" sheet once when it is there. */
export const PASSKEY_OFFER_COOKIE = "onsite_passkey_offer";

/** "Not now" is remembered on this phone for 30 days. */
export const NOT_NOW_KEY = "onsite:passkey-not-now";
export const NOT_NOW_DAYS = 30;
/** Credential ids set up or used on this phone, so the sheet doesn't offer what is already here. */
const HERE_KEY = "onsite:passkeys-here";

/** A challenge lives 5 minutes on the server; options older than this are fetched again rather than used. */
export const OPTIONS_FRESH_MS = 4 * 60 * 1000;

export const PASSKEY_WORDS = {
  cancelled: "No problem — sign in with a text code instead.",
  unknown: "That Face ID sign-in isn't linked to an account any more. Use a text code.",
  expired: "That took too long. Try again, or sign in with a text code.",
  failed: "Face ID sign-in didn't work this time. Sign in with a text code instead.",
  busy: "Too many tries from this connection. Sign in with a text code instead.",
  off: "Face ID sign-in isn't available right now. Sign in with a text code instead.",
} as const;
export type PasskeyReason = keyof typeof PASSKEY_WORDS;

const read = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
};
const write = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: the sheet may ask again, nothing breaks */ }
};

export const saidNotNowRecently = (now = Date.now()) => {
  const at = Number(read(NOT_NOW_KEY, 0));
  return at > 0 && at <= now && now - at < NOT_NOW_DAYS * 24 * 60 * 60 * 1000;
};
export const rememberNotNow = () => write(NOT_NOW_KEY, Date.now());

export const rememberHere = (...ids: string[]) =>
  write(HERE_KEY, [...new Set([...ids, ...read<string[]>(HERE_KEY, [])])].slice(0, 20));
export const forgetHere = (id: string) => write(HERE_KEY, read<string[]>(HERE_KEY, []).filter((x) => x !== id));
/** One of this person's passkeys (as the server lists them) was set up or used on this phone. */
export const setUpHere = (serverIds: string[]) => read<string[]>(HERE_KEY, []).some((id) => serverIds.includes(id));

/** The page is on the origin the server verifies against, in a secure context. Anything else fails at the browser. */
const onOurOrigin = (origin: string) => typeof window !== "undefined" && window.isSecureContext && window.location.origin === origin;

/** This phone can make one: WebAuthn plus a built-in authenticator (Face ID, fingerprint, screen lock). */
export async function canAddPasskey(origin: string): Promise<boolean> {
  if (!onOurOrigin(origin) || !browserSupportsWebAuthn()) return false;
  try { return await platformAuthenticatorIsAvailable(); } catch { return false; }
}

/** This browser can sign in with one — its own, or a phone's nearby. */
export async function canSignInWithPasskey(origin: string): Promise<boolean> {
  if (!onOurOrigin(origin) || !browserSupportsWebAuthn()) return false;
  try { return await browserSupportsPasskeys(); } catch { return false; }
}

/** Passkeys offered in the keyboard's suggestions when the phone box is focused (conditional mediation). */
export async function canAutofillPasskey(origin: string): Promise<boolean> {
  if (!onOurOrigin(origin)) return false;
  try { return await browserSupportsWebAuthnAutofill(); } catch { return false; }
}

/**
 * How a browser ceremony ended, from what @simplewebauthn/browser threw.
 *  - aborted:   we cancelled it ourselves (the button took over from autofill, the screen moved on) — say nothing
 *  - cancelled: the person closed the prompt, or it timed out (browsers don't tell those apart)
 *  - exists:    this phone already holds one of their passkeys
 *  - other:     anything else
 */
export function ceremonyEnd(e: unknown): "aborted" | "cancelled" | "exists" | "other" {
  const err = e as { code?: string; name?: string; cause?: { name?: string } } | null;
  const name = err?.cause?.name ?? err?.name;
  if (err?.code === "ERROR_CEREMONY_ABORTED" || name === "AbortError") return "aborted";
  if (err?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") return "exists";
  if (name === "NotAllowedError") return "cancelled";
  return "other";
}

/** "Face ID" on Apple phones, "fingerprint" on Android, both elsewhere. Words only — the phone decides what it asks for. */
export function unlockWords(ua: string): "Face ID" | "your fingerprint" | "Face ID or fingerprint" {
  if (/iPhone|iPad|iPod/.test(ua)) return "Face ID";
  if (/Android/.test(ua)) return "your fingerprint";
  return "Face ID or fingerprint";
}
