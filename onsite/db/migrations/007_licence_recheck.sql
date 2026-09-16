-- 007: a White Card check that couldn't complete (register down, timeout, throttled, or the app's daily
-- budget spent) is tried again by the cron instead of staying 'unchecked' for ever. lib/licenceRecheck.ts
-- has the schedule. Saving a card sets or clears both columns; nothing else queues a card.
ALTER TABLE licences ADD COLUMN IF NOT EXISTS recheck_at     timestamptz;                 -- next automatic try; NULL = not queued
ALTER TABLE licences ADD COLUMN IF NOT EXISTS check_attempts smallint NOT NULL DEFAULT 0; -- re-checks that failed since the last save
CREATE INDEX IF NOT EXISTS licences_recheck_idx ON licences (recheck_at) WHERE recheck_at IS NOT NULL;
