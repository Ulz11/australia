-- 002: worker profiles, licence verification, deal requests (offers),
--      site crew cap, agreed overtime terms, weather stop.
-- Additive and idempotent — safe to re-run.

------------------------------------------------------------------ profile
ALTER TABLE workers ADD COLUMN IF NOT EXISTS photo      text;        -- small square data URL, see PHOTO_MAX_BYTES
ALTER TABLE workers ADD COLUMN IF NOT EXISTS years_exp  int;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS trades     text[] NOT NULL DEFAULT '{}';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS languages  text[] NOT NULL DEFAULT '{}';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS about      text;

-- One row per card the worker holds. workers.tickets stays the fast array the
-- matching query uses; this table carries the number, expiry and check record.
CREATE TABLE IF NOT EXISTS licences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  kind         text NOT NULL,                     -- WC, LF, WP, DG, SB
  number       text,
  issued_state text,                              -- NSW, VIC, QLD, WA, SA, TAS, ACT, NT
  expires_on   date,
  holder_name  text,                              -- name as printed on the card
  -- never says 'verified' unless a check actually ran and matched
  status       text NOT NULL DEFAULT 'unchecked'
               CHECK (status IN ('unchecked','checking','verified','not_found','expired','mismatch')),
  checked_at   timestamptz,
  checked_via  text,                              -- 'safework_nsw' | 'manual' | null
  check_note   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, kind)
);
CREATE INDEX IF NOT EXISTS licences_worker_idx ON licences(worker_id);
-- queue for whoever does the manual checks
CREATE INDEX IF NOT EXISTS licences_pending_idx ON licences(created_at) WHERE status = 'unchecked';

------------------------------------------------------------- site crew cap
-- How many people the site needs in total, own crew + casuals. NULL = no cap.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS crew_target int;

-------------------------------------------------- overtime agreed in advance
-- Agreed when the shift is posted and shown to the worker before they take it,
-- so the number is settled before anyone picks up a tool.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS ot_mode        text NOT NULL DEFAULT 'award'
                                            CHECK (ot_mode IN ('award','flat','custom'));
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS ot_after_hours numeric(4,1) NOT NULL DEFAULT 8;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS ot_multiplier  numeric(3,2);   -- 'custom' only, e.g. 1.50
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS allow_offers   boolean NOT NULL DEFAULT true;

------------------------------------------------------------------ weather
-- Construction stops for rain. The boss decides the money; the app records it.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS weather_stop text
                                            CHECK (weather_stop IN ('rain','wind','heat','storm','other'));
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS weather_note text;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS weather_at   timestamptz;

-------------------------------------------------- negotiated terms per booking
-- NULL means "same as the shift". Set when an offer is accepted.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_rate  numeric(6,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_hours numeric(4,1);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_start time;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pay_reason   text;   -- why approved hours differ, e.g. 'Rained out 10am'

------------------------------------------------------- offers / deal requests
CREATE TABLE IF NOT EXISTS offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id     uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  worker_id    uuid NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  from_role    text NOT NULL CHECK (from_role IN ('worker','boss')),
  rate         numeric(6,2),      -- NULL on any field = "no change from the shift"
  hours        numeric(4,1),
  start_time   time,
  message      text,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','declined','countered','withdrawn','expired')),
  parent_id    uuid REFERENCES offers(id) ON DELETE CASCADE,   -- a boss counter points at the worker's offer
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);
CREATE INDEX IF NOT EXISTS offers_shift_idx  ON offers(shift_id);
CREATE INDEX IF NOT EXISTS offers_worker_idx ON offers(worker_id, created_at DESC);
-- one live offer per worker per shift
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_open ON offers(shift_id, worker_id) WHERE status = 'pending';

-------------------------------------------------------------------- views
-- How full a site is: own crew who worked it recently + everyone booked ahead.
CREATE OR REPLACE VIEW site_crew AS
SELECT p.id AS project_id, p.boss_id, p.crew_target,
       COUNT(DISTINCT b.worker_id) FILTER (
         WHERE s.day >= CURRENT_DATE AND b.status NOT IN ('removed','cancelled')
       )::int AS booked_ahead
FROM projects p
LEFT JOIN shifts s   ON s.project_id = p.id AND s.status IN ('open','filled')
LEFT JOIN bookings b ON b.shift_id = s.id
GROUP BY p.id, p.boss_id, p.crew_target;
