-- 017: the usual week. One definition of "is this worker free on this day", used by every query that asks.
-- db/migrate.ts re-runs every file, so everything here is additive and idempotent.
--
-- Until now a missing `availability` row meant busy, so a worker was invisible to every boss on every day
-- they hadn't tapped. Most workers work the same days most weeks; now they say so once.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS usual_days smallint[] NOT NULL DEFAULT '{}';   -- ISO weekdays, 1 = Mon … 7 = Sun

-- The one answer, so matching, the map, the calendar and the worker's own screens can never drift apart:
--
--   an explicit availability row always wins  ('free' → yes, 'busy' → no)
--   no row → yes only if the day's weekday is in their usual week AND they have opened OnSite in the last
--            14 days (users.last_seen_at, migration 015) — a pattern nobody has come back to isn't a promise,
--            and a boss shown someone who has moved on rings a phone that never answers.
--
-- Named p_worker / p_day rather than worker_id / day: a SQL function body can't tell a parameter from a
-- column of the same name.
CREATE OR REPLACE FUNCTION worker_free(p_worker uuid, p_day date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT a.status = 'free' FROM availability a WHERE a.worker_id = p_worker AND a.day = p_day),
    EXTRACT(ISODOW FROM p_day)::smallint = ANY (w.usual_days)
      AND u.last_seen_at IS NOT NULL
      AND u.last_seen_at > now() - interval '14 days'
  )
  FROM workers w JOIN users u ON u.id = w.user_id
  WHERE w.user_id = p_worker
$$;

-- Everyone already using OnSite is counted as here now, so nobody's usual week is dead the day it is set.
UPDATE users SET last_seen_at = now() WHERE last_seen_at IS NULL;
