-- 020: every site keeps its own clock.
-- db/migrate.ts re-runs every file, so everything here is additive and idempotent.
--
-- lib/db.ts asks for TimeZone = Australia/Sydney when a connection opens. DATABASE_URL points at Neon's
-- pooler, and PgBouncer drops startup parameters it doesn't pass on: on the live database
-- current_setting('TimeZone') answers 'GMT' and pg_settings says source = 'default'. So CURRENT_DATE was
-- yesterday for the first ten hours of every Sydney day, and clockIn's "s.day = CURRENT_DATE" refused every
-- clock-in on a morning shift — the app's own default start is 06:30. The fix is to stop asking the
-- connection what day it is and ask the job, so each site carries its zone on the row.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tz text NOT NULL DEFAULT 'Australia/Sydney';

-- Whether that zone is still our guess from the pin, or a person's answer. Without it the backfill below
-- can't tell "nobody has said" from "a boss chose Sydney for a Perth-pinned site", and re-running the
-- migration — which db/migrate.ts does every deploy — would quietly overrule them. The site form sets it
-- false when someone picks a zone.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tz_auto boolean NOT NULL DEFAULT true;

-- Approximate backfill from the pin. Documented as approximate; the site form is authoritative
-- and a boss can change it. Only runs where nobody has set it.
UPDATE projects SET tz = CASE
  WHEN ST_X(location::geometry) < 129                                    THEN 'Australia/Perth'
  WHEN ST_X(location::geometry) < 138 AND ST_Y(location::geometry) > -26 THEN 'Australia/Darwin'
  WHEN ST_X(location::geometry) < 141                                    THEN 'Australia/Adelaide'
  WHEN ST_Y(location::geometry) > -29                                    THEN 'Australia/Brisbane'
  WHEN ST_Y(location::geometry) < -40                                    THEN 'Australia/Hobart'
  WHEN ST_X(location::geometry) < 148 AND ST_Y(location::geometry) < -34 THEN 'Australia/Melbourne'
  ELSE 'Australia/Sydney' END
WHERE tz_auto;
