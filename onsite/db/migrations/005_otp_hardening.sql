-- 005: login codes that can't be brute-forced or farmed.
-- otp_codes.code now holds an HMAC of the code, never the code. Old plain codes simply fail to match and expire in 10 min.
-- Counters for per-IP and global limits (fixed windows, updated in one statement).
CREATE TABLE IF NOT EXISTS rate_limits (
  key          text PRIMARY KEY,           -- e.g. 'otp-send:ip:1.2.3.4', 'otp-send:all'
  window_start timestamptz NOT NULL,
  hits         int NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits (window_start);
