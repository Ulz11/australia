-- 008: closed beta. db/migrate.ts re-runs every file on every migrate, so everything here is additive and idempotent.

-- Who may ask for a login code while BETA_INVITE_ONLY=1 (lib/beta.ts). People who already have an account
-- (a users row) may always sign in. Managed with: npm run beta:invite -- 0412345678 [--role worker|boss] [--note "…"]
CREATE TABLE IF NOT EXISTS beta_invites (
  phone              text PRIMARY KEY,                           -- E.164, as normalisePhone writes it: +61412345678
  role               text CHECK (role IN ('boss','worker')),     -- what they were invited as; a note for us, not enforced
  note               text,
  invited_at         timestamptz NOT NULL DEFAULT now(),
  first_signed_in_at timestamptz                                 -- stamped by the first code that signs them in (lib/otpVerify.ts)
);

-- Consent to the privacy notice (/privacy), given at onboarding and enforced by completeOnboarding.
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version     text;   -- PRIVACY_VERSION in lib/privacy.ts at the time
