-- 018: shift reminders (lib/reminders.ts), written by the 20-minute cron and delivered by lib/alerts.ts.
-- db/migrate.ts re-runs every file, so everything here is additive and idempotent.

-- Whether a notification is the orange kind: something the person has to do, not something they should know.
-- Until now only a shift starting within three hours was urgent, and that was worked out at delivery time from
-- the shift. A boss's "tomorrow" reminder is urgent only when spots are still open, which is known when the row
-- is written and not afterwards — so the row carries it.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false;

-- One reminder of each kind per person per shift, ever. The cron runs every 20 minutes and the windows below
-- are wider than that, so passes overlap on purpose; this index is what makes a second pass write nothing.
-- Same shape as notif_match_once.
CREATE UNIQUE INDEX IF NOT EXISTS notif_reminder_once ON notifications(user_id, shift_id, kind)
  WHERE kind IN ('reminder_eve', 'reminder_soon', 'tomorrow');
