-- 006: alerts that reach the phone. Notifications become an outbox: each row is pushed (and, for shift
-- offers, texted) once, then stamped. A phone that turns alerts on leaves one push subscription here.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     text PRIMARY KEY,                               -- the push service URL for one browser on one phone
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  failures     int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_at  timestamptz;   -- claimed for delivery (re-claimable after 2 min while sent_via is NULL)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_via text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sms_at  timestamptz;   -- a text is paid for and can't be un-sent: never send the same one twice          -- 'push' | 'sms' | 'push+sms' | 'none' | 'expired'
DROP INDEX IF EXISTS notif_unsent_idx;
CREATE INDEX IF NOT EXISTS notif_undelivered_idx ON notifications (created_at) WHERE sent_via IS NULL;
