-- 003: stop SMS bombing. One code a minute per phone, five an hour.
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS sends        int NOT NULL DEFAULT 0;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS window_start timestamptz;
