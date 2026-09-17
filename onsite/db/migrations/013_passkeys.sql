-- 013: Face ID / fingerprint sign-in (passkeys, WebAuthn). lib/passkeys.ts, actions/passkeys.ts.
-- Additive and idempotent — db/migrate.ts re-runs every file.

------------------------------------------------------------------ one row per device someone turned it on for
-- Only the public half of a key pair lives here. The private half, and the face or fingerprint that unlocks it,
-- never leave the phone (or its password manager: iCloud Keychain, Google Password Manager).
CREATE TABLE IF NOT EXISTS passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,                   -- base64url, exactly as the browser reports it
  public_key    bytea NOT NULL,                         -- COSE public key
  counter       bigint NOT NULL DEFAULT 0,              -- synced passkeys always report 0
  transports    text[] NOT NULL DEFAULT '{}',
  device_type   text NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up     boolean NOT NULL DEFAULT false,
  label         text NOT NULL,                          -- "iPhone", "Android phone" — from the user agent, for Me
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys(user_id);

------------------------------------------------------------------ challenges: single use, five minutes
-- In the database rather than a signed cookie: a cookie can't be spent (a replayed request carrying the same
-- cookie and assertion would verify again, and synced passkeys report counter 0, so the counter won't catch it),
-- and every serverless instance already shares this database. A row is spent by the DELETE that checks it.
-- A login challenge belongs to nobody yet (the passkey says who it is); a registration one to the signed-in user.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('register','login')),
  challenge  text NOT NULL UNIQUE,                      -- base64url of 32 random bytes
  expires_at timestamptz NOT NULL,
  CHECK ((kind = 'register') = (user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_idx ON webauthn_challenges(expires_at);
