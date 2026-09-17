-- 019: a boss brings their own crew (lib/crew.ts, actions/boss.ts importCrew).
-- db/migrate.ts re-runs every file, so everything here is additive and idempotent.
--
-- Adding a worker by phone used to refuse any number that wasn't already on OnSite — which is most of a real
-- crew. Now an unknown number becomes an invite: a row only this boss can see, kept long enough to recognise
-- the person if they sign up, and swept by the cron when it runs out.
CREATE TABLE IF NOT EXISTS crew_invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boss_id    uuid NOT NULL REFERENCES bosses(user_id) ON DELETE CASCADE,
  phone      text NOT NULL,                                   -- E.164, as normalisePhone writes it
  name       text,                                            -- what the boss called them, if they typed a name
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at  timestamptz,                                     -- when that number signed up and landed in the crew
  worker_id  uuid REFERENCES workers(user_id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
  texted_at  timestamptz,                                     -- at most one text per invite, ever
  UNIQUE (boss_id, phone)
);
-- "did anyone invite this number?" — asked once, when someone finishes signing up.
CREATE INDEX IF NOT EXISTS crew_invites_phone_idx ON crew_invites(phone) WHERE joined_at IS NULL;
-- the cron's 90-day sweep
CREATE INDEX IF NOT EXISTS crew_invites_expiry_idx ON crew_invites(expires_at) WHERE joined_at IS NULL;

-- The boss's own join link, /join/c/<code> — the same shape as a worker's mate-invite code.
ALTER TABLE bosses ADD COLUMN IF NOT EXISTS invite_code text UNIQUE;

-- Every boss that already exists gets one. Retried on a clash rather than trusting six random characters.
DO $$
DECLARE b record; code text;
BEGIN
  FOR b IN SELECT user_id FROM bosses WHERE invite_code IS NULL LOOP
    LOOP
      code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
      BEGIN
        UPDATE bosses SET invite_code = code WHERE user_id = b.user_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- try another
      END;
    END LOOP;
  END LOOP;
END $$;
