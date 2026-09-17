/**
 * The rules at /terms (app/terms/page.tsx) and the consent onboarding asks for, beside the privacy notice.
 *
 * Change TERMS_VERSION whenever what the page says changes: users.terms_version records which version
 * someone agreed to (migration 016), so anyone who agreed to an older one can be asked again. It is the
 * date of the change, with ".2", ".3"… for further changes on the same day — the same shape as
 * PRIVACY_VERSION (lib/privacy.ts).
 *
 * Existing accounts are deliberately not asked again: nothing re-consents anyone today.
 */
export const TERMS_VERSION = "2026-09-18";
