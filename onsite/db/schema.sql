-- OnSite MVP schema. Postgres 16+ with PostGIS.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text UNIQUE NOT NULL,          -- E.164, e.g. +61412345678
  name        text,
  role        text CHECK (role IN ('boss','worker')),
  lang        text NOT NULL DEFAULT 'en',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone       text PRIMARY KEY,
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bosses (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company     text NOT NULL,
  abn         text,
  pay_mode    text NOT NULL DEFAULT 'award' CHECK (pay_mode IN ('award','flat'))
);

CREATE TABLE IF NOT EXISTS workers (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home        geography(Point,4326),
  home_label  text,
  radius_km   int NOT NULL DEFAULT 25,
  tickets     text[] NOT NULL DEFAULT '{}',   -- 'WC' white card, 'LF','WP','DG','SB'
  visa_type   text,                            -- display only
  invite_code text UNIQUE NOT NULL,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Availability: a day is 'free' or 'busy'. Missing row = busy (worker must opt in).
CREATE TABLE IF NOT EXISTS availability (
  worker_id   uuid REFERENCES workers(user_id) ON DELETE CASCADE,
  day         date NOT NULL,
  status      text NOT NULL CHECK (status IN ('free','busy')),
  PRIMARY KEY (worker_id, day)
);

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boss_id     uuid NOT NULL REFERENCES bosses(user_id) ON DELETE CASCADE,
  name        text NOT NULL,
  address     text,
  location    geography(Point,4326) NOT NULL,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_location_idx ON projects USING GIST (location);
CREATE INDEX IF NOT EXISTS workers_home_idx ON workers USING GIST (home);

CREATE TABLE IF NOT EXISTS shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  boss_id           uuid NOT NULL REFERENCES bosses(user_id) ON DELETE CASCADE,
  day               date NOT NULL,
  start_time        time NOT NULL DEFAULT '06:30',
  hours             numeric(4,1) NOT NULL DEFAULT 8,
  spots             int NOT NULL DEFAULT 1,
  role              text NOT NULL DEFAULT 'General labourer',
  tickets_required  text[] NOT NULL DEFAULT '{WC}',
  rate              numeric(6,2) NOT NULL,      -- $/h casual, incl. 25% loading
  note              text,
  direct_worker_id  uuid REFERENCES workers(user_id) ON DELETE SET NULL,  -- "Book again": skip matching
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed','cancelled')),
  notify_round      int NOT NULL DEFAULT 0,
  last_notified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shifts_day_idx ON shifts(day) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id         uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  worker_id        uuid NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'accepted'
                   CHECK (status IN ('accepted','clocked_in','clocked_out','approved','paid','removed','cancelled')),
  clock_in_at      timestamptz,
  clock_in_dist_m  int,
  clock_out_at     timestamptz,
  hours_worked     numeric(4,1),
  hours_approved   numeric(4,1),
  approved_at      timestamptz,
  paid_at          timestamptz,
  disputed_at      timestamptz,
  worker_note      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, worker_id)
);

CREATE TABLE IF NOT EXISTS crew (
  boss_id     uuid REFERENCES bosses(user_id) ON DELETE CASCADE,
  worker_id   uuid REFERENCES workers(user_id) ON DELETE CASCADE,
  type        text NOT NULL DEFAULT 'casual' CHECK (type IN ('fulltime','casual')),
  rate        numeric(6,2),
  since       date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (boss_id, worker_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  boss_id     uuid REFERENCES bosses(user_id) ON DELETE CASCADE,
  worker_id   uuid REFERENCES workers(user_id) ON DELETE CASCADE,
  by_role     text NOT NULL CHECK (by_role IN ('boss','worker')),
  PRIMARY KEY (boss_id, worker_id)
);

-- One row per (shift, worker) notified. Drives the "3x spots per round" batching.
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id    uuid REFERENCES shifts(id) ON DELETE CASCADE,
  kind        text NOT NULL,     -- shift_match | booking | hours_approved | paid | edited
  body        text NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notif_match_once ON notifications(user_id, shift_id) WHERE kind = 'shift_match';

-- Call log: either side tapped the phone number. Shows a conversation happened.
CREATE TABLE IF NOT EXISTS calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user   uuid NOT NULL REFERENCES users(id),
  to_user     uuid NOT NULL REFERENCES users(id),
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Reliability: shows up (accepted -> clocked in) on past shifts; cancellations count against.
CREATE OR REPLACE VIEW worker_stats AS
SELECT w.user_id AS worker_id,
       COUNT(b.id) FILTER (WHERE s.day < CURRENT_DATE AND b.status <> 'removed')                        AS past_shifts,
       COUNT(b.id) FILTER (WHERE s.day < CURRENT_DATE AND b.status IN ('clocked_in','clocked_out','approved','paid')) AS showed,
       COUNT(b.id) FILTER (WHERE b.status = 'cancelled')                                                 AS cancels,
       COUNT(b.id) FILTER (WHERE b.status IN ('approved','paid'))                                        AS completed
FROM workers w
LEFT JOIN bookings b ON b.worker_id = w.user_id
LEFT JOIN shifts s ON s.id = b.shift_id
GROUP BY w.user_id;

-- Boss reliability: how fast hours get approved and paid.
CREATE OR REPLACE VIEW boss_stats AS
SELECT bo.user_id AS boss_id,
       COUNT(b.id) FILTER (WHERE b.status IN ('approved','paid')) AS approved_count,
       ROUND(AVG(EXTRACT(EPOCH FROM (b.approved_at - b.clock_out_at))/3600)::numeric,1) AS approve_hours_avg,
       ROUND(AVG(EXTRACT(EPOCH FROM (b.paid_at - b.approved_at))/86400)::numeric,1)     AS pay_days_avg
FROM bosses bo
LEFT JOIN shifts s ON s.boss_id = bo.user_id
LEFT JOIN bookings b ON b.shift_id = s.id
GROUP BY bo.user_id;


-- ===== 002 =====
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
