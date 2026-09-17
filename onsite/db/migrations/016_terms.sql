-- 016: the rules at /terms, agreed at onboarding beside the privacy notice (lib/terms.ts).
-- db/migrate.ts re-runs every file, so this is additive and idempotent.
--
-- Same shape as the privacy consent in 008: when they agreed, and to which version — so anyone who agreed
-- to an older set of rules can be asked again. Existing accounts are not re-asked today.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version     text;   -- TERMS_VERSION in lib/terms.ts at the time
