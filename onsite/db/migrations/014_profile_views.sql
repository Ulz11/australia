-- 014: who looked at a worker's profile. db/migrate.ts re-runs every file, so this is additive and idempotent.
--
-- One row per boss, worker and day: a boss who opens the same profile six times in a morning is one look,
-- and the worker is only ever told how many bosses looked, never which. The day is a Sydney date, written
-- by the page itself (app/boss/workers/[id]/page.tsx, after the response).
CREATE TABLE IF NOT EXISTS profile_views (
  boss_id   uuid NOT NULL REFERENCES bosses(user_id)  ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  day       date NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (boss_id, worker_id, day)
);
-- "how many bosses looked at me this week" — the only question anyone asks of this table.
CREATE INDEX IF NOT EXISTS profile_views_worker_idx ON profile_views(worker_id, day);
