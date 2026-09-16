-- 010: what the boss pays for. Two things and no card anywhere.
--
--   * a subscription, $33 a month including GST, for the pay tools, after a 3-day free trial
--   * a $2 match fee the first time OnSite introduces a boss to a worker and that worker's
--     hours are approved — repeat shifts with the same worker are free forever
--
-- Invoices here are records, not charges: nothing in this app moves money. A human marks one paid
-- (npm run billing:paid). Additive and idempotent — safe to re-run.

------------------------------------------------------------------ the subscription, on the boss
ALTER TABLE bosses ADD COLUMN IF NOT EXISTS trial_ends_at             timestamptz;
ALTER TABLE bosses ADD COLUMN IF NOT EXISTS subscription_status       text NOT NULL DEFAULT 'trialing';
ALTER TABLE bosses ADD COLUMN IF NOT EXISTS period_started_at         timestamptz;
ALTER TABLE bosses ADD COLUMN IF NOT EXISTS period_ends_at            timestamptz;
ALTER TABLE bosses ADD COLUMN IF NOT EXISTS subscription_cancelled_at timestamptz;

-- ADD CONSTRAINT has no IF NOT EXISTS, so ask pg_constraint first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bosses_subscription_status_ck') THEN
    ALTER TABLE bosses ADD CONSTRAINT bosses_subscription_status_ck
      CHECK (subscription_status IN ('trialing','active','cancelling','lapsed'));
  END IF;
END $$;

-- The cron walks these every 20 minutes; both are tiny, partial and cheap.
CREATE INDEX IF NOT EXISTS bosses_trial_idx  ON bosses(trial_ends_at) WHERE subscription_status = 'trialing';
CREATE INDEX IF NOT EXISTS bosses_period_idx ON bosses(period_ends_at) WHERE subscription_status IN ('active','cancelling');

------------------------------------------------------------------ who OnSite introduced to whom
-- One row per (boss, worker) pair OnSite put together, written the moment the booking is made.
-- A pair the boss already knew — their own crew, a direct "book again", "same again tomorrow" —
-- never gets a row, so it is never billable. An introduced pair stays introduced: if the boss later
-- books that worker directly, the first approved shift still bills.
CREATE TABLE IF NOT EXISTS introductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boss_id           uuid NOT NULL REFERENCES bosses(user_id)  ON DELETE CASCADE,
  worker_id         uuid NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  introduced_at     timestamptz NOT NULL DEFAULT now(),
  via               text NOT NULL CHECK (via IN ('match','offer')),
  first_booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  billed_at         timestamptz,                                  -- when approved hours > 0 made it billable
  billed_booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  invoice_line_id   uuid,                                         -- filled when it lands on an invoice
  UNIQUE (boss_id, worker_id)
);
-- "which matches does this period's invoice bill?" — billed, not yet on a line.
CREATE INDEX IF NOT EXISTS introductions_to_bill_idx ON introductions(boss_id, billed_at) WHERE invoice_line_id IS NULL;

------------------------------------------------------------------ invoices
CREATE TABLE IF NOT EXISTS invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text UNIQUE NOT NULL,                             -- OS-2026-000123
  boss_id       uuid NOT NULL REFERENCES bosses(user_id) ON DELETE CASCADE,
  period_start  timestamptz NOT NULL,                             -- the period whose matches this bills
  period_end    timestamptz NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  due_at        timestamptz NOT NULL,
  subtotal_cents int NOT NULL,
  gst_cents     int NOT NULL DEFAULT 0,
  total_cents   int NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  paid_at       timestamptz,
  paid_note     text,
  UNIQUE (boss_id, period_start)                                  -- closing the same period twice can't invoice twice
);
CREATE INDEX IF NOT EXISTS invoices_boss_idx ON invoices(boss_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('subscription','match')),
  description  text NOT NULL,
  qty          int NOT NULL DEFAULT 1,
  unit_cents   int NOT NULL,
  amount_cents int NOT NULL,
  worker_id    uuid REFERENCES workers(user_id) ON DELETE SET NULL,
  booking_id   uuid REFERENCES bookings(id)     ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines(invoice_id);

-- Invoice numbers: unique, and sequential within a year. One row per year, bumped in the same
-- transaction that writes the invoice, so two bosses invoiced in the same second can't collide.
CREATE TABLE IF NOT EXISTS invoice_counters (
  year        int PRIMARY KEY,
  last_number int NOT NULL DEFAULT 0
);

------------------------------------------------------------------ backfill: bosses who are already here
-- Everyone gets the same 3 days from when they signed up. A trial that is already over means the
-- subscription is running; one still to come stays a trial.
UPDATE bosses b SET trial_ends_at = COALESCE(u.created_at, now()) + interval '3 days'
  FROM users u WHERE u.id = b.user_id AND b.trial_ends_at IS NULL;
UPDATE bosses SET trial_ends_at = now() + interval '3 days' WHERE trial_ends_at IS NULL;

-- Periods are anniversaries of the trial end. A boss whose trial ended months ago is put into the
-- period they are actually in now — stepping whole months from that anchor, so their billing day
-- never moves — rather than being walked through every month since and invoiced for each. Nobody
-- gets a bill for a month OnSite never billed them for.
UPDATE bosses SET
  subscription_status = CASE WHEN trial_ends_at <= now() THEN 'active' ELSE 'trialing' END,
  period_started_at = trial_ends_at + (GREATEST(0,
    EXTRACT(YEAR FROM age(now(), trial_ends_at)) * 12 + EXTRACT(MONTH FROM age(now(), trial_ends_at))
  )::int * interval '1 month')
WHERE period_started_at IS NULL;
UPDATE bosses SET period_ends_at = period_started_at + interval '1 month' WHERE period_ends_at IS NULL;

-- Pairs that already worked together through a shift OnSite posted to the pool become introductions,
-- already billed and with no invoice line: grandfathered, so nobody is charged for their own history.
-- That holds even for a pair whose first shift was never approved: they met before there was a fee,
-- so their next approved shift is free too. The billed stamp is the pair's first approval of more
-- than 0 hours if there was one, otherwise the moment they were introduced.
INSERT INTO introductions (boss_id, worker_id, introduced_at, via, first_booking_id, billed_at, billed_booking_id)
SELECT DISTINCT ON (s.boss_id, b.worker_id)
  s.boss_id, b.worker_id, b.created_at, 'match', b.id,
  COALESCE(fa.approved_at, b.created_at), COALESCE(fa.id, b.id)
FROM bookings b
JOIN shifts s ON s.id = b.shift_id
LEFT JOIN LATERAL (
  SELECT b2.id, b2.approved_at
  FROM bookings b2 JOIN shifts s2 ON s2.id = b2.shift_id
  WHERE s2.boss_id = s.boss_id AND b2.worker_id = b.worker_id
    AND b2.hours_approved > 0 AND b2.approved_at IS NOT NULL
  ORDER BY b2.approved_at LIMIT 1
) fa ON true
WHERE s.direct_worker_id IS NULL
  AND b.status NOT IN ('removed','cancelled')
ORDER BY s.boss_id, b.worker_id, b.created_at
ON CONFLICT (boss_id, worker_id) DO NOTHING;
