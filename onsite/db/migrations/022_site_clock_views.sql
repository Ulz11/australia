-- 022: the two views that decide "past" and "ahead" now read the SITE's clock, not the connection's.
--
-- db/schema.sql and 002 already name a zone instead of CURRENT_DATE, which is what killed the GMT bug —
-- through Neon's pooler the session runs in GMT, so CURRENT_DATE was yesterday for the first ten hours of
-- every Sydney day (lib/siteClock.ts). But they can only name the APP's zone, because projects.tz does not
-- exist until migration 020 and a view cannot reference a column that is not there yet. This file runs
-- after 020, so here the views can finally ask each shift's own site what day it is.
--
-- It matters most in worker_stats: that view is what lib/matching.ts ranks people on. A Perth shift rolls
-- over its day three hours after a Sydney one, so on the app's clock a worker's last shift could count as
-- "past" — and drag their turn-up score — while it had not started yet where the job actually is.
--
-- CREATE OR REPLACE VIEW keeps the column names, types and order identical, which is the only thing it
-- allows to stay the same; re-running this file is therefore a no-op, as db/migrate.ts requires.
-- COALESCE because the join is LEFT: a booking whose shift or project has gone leaves p.tz null, and
-- `now() AT TIME ZONE NULL` is null, which would silently drop that row out of every FILTER.

CREATE OR REPLACE VIEW worker_stats AS
SELECT w.user_id AS worker_id,
       COUNT(b.id) FILTER (WHERE s.day < (now() AT TIME ZONE COALESCE(p.tz, 'Australia/Sydney'))::date
                             AND b.status <> 'removed')                                                  AS past_shifts,
       COUNT(b.id) FILTER (WHERE s.day < (now() AT TIME ZONE COALESCE(p.tz, 'Australia/Sydney'))::date
                             AND b.status IN ('clocked_in','clocked_out','approved','paid'))             AS showed,
       COUNT(b.id) FILTER (WHERE b.status = 'cancelled')                                                 AS cancels,
       COUNT(b.id) FILTER (WHERE b.status IN ('approved','paid'))                                        AS completed
FROM workers w
LEFT JOIN bookings b ON b.worker_id = w.user_id
LEFT JOIN shifts s   ON s.id = b.shift_id
LEFT JOIN projects p ON p.id = s.project_id
GROUP BY w.user_id;

CREATE OR REPLACE VIEW site_crew AS
SELECT p.id AS project_id, p.boss_id, p.crew_target,
       COUNT(DISTINCT b.worker_id) FILTER (
         WHERE s.day >= (now() AT TIME ZONE COALESCE(p.tz, 'Australia/Sydney'))::date
           AND b.status NOT IN ('removed','cancelled')
       )::int AS booked_ahead
FROM projects p
LEFT JOIN shifts s   ON s.project_id = p.id AND s.status IN ('open','filled')
LEFT JOIN bookings b ON b.shift_id = s.id
GROUP BY p.id, p.boss_id, p.crew_target;

-- crew.since is stamped once, when a boss puts someone on their crew, and there is no site on that row to
-- ask — so the app's zone is the honest answer here rather than a guess at which job they were added from.
ALTER TABLE crew ALTER COLUMN since SET DEFAULT (now() AT TIME ZONE 'Australia/Sydney')::date;
