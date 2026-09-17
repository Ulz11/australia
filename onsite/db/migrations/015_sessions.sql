-- 015: real sessions. A sign-in is a row, not just a signed cookie (lib/session.ts).
-- db/migrate.ts re-runs every file, so everything here is additive and idempotent.
--
-- Until now the token was the whole truth: a deleted account's cookie still opened pages, removing a
-- passkey changed nothing for the phone that used it, and signing out only dropped that browser's cookie.
-- Now the token carries a session id and every read joins this table, so a row that is gone or revoked
-- is a signed-out phone — everywhere, at once.
CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set when Face ID signed this phone in. Removing that passkey takes the session with it (cascade),
  -- which is what "remove the passkey and that phone is signed out" means.
  passkey_id   uuid REFERENCES passkeys(id) ON DELETE CASCADE,
  via          text NOT NULL CHECK (via IN ('code','passkey','mobile')),
  label        text NOT NULL,                       -- "iPhone", "Android phone" — lib/passkeys.ts deviceLabel
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz                          -- signed out, here or from another phone
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- When this person last had the app open. Bumped by sign-in and by the refresh routes (at most every 6 h per
-- browser), so it is a "still using OnSite" mark rather than a log. The usual week reads it: a worker who
-- stopped opening the app stops being shown to bosses as free (migration 016, worker_free).
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
