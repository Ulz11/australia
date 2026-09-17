/**
 * The privacy notice at /privacy (app/privacy/page.tsx) and the consent onboarding asks for.
 *
 * Change PRIVACY_VERSION whenever what the notice says changes: users.privacy_version records which
 * version someone agreed to (migration 008), so anyone who agreed to an older one can be asked again.
 * It is the date of the change, with ".2", ".3"… for further changes on the same day.
 */
export const PRIVACY_VERSION = "2026-09-17.2";   // a second change on the same day gets ".2": Face ID / fingerprint sign-in

/**
 * Who to contact about privacy. Read from the environment when the page is requested (never baked in at
 * build time). Null when either is missing — the page then shows no contact line rather than inventing one.
 */
export function privacyContact(env: Record<string, string | undefined> = process.env): { email: string; business: string } | null {
  const email = env.PRIVACY_CONTACT_EMAIL?.trim();
  const business = env.BUSINESS_NAME?.trim();
  return email && business ? { email, business } : null;
}
