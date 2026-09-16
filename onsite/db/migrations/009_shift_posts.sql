-- 009: one job post, several kinds of worker. db/migrate.ts re-runs every file on every migrate, so this is additive and idempotent.
--
-- "2 carpenters, 1 forklift driver and 3 labourers" is three shift rows — one per kind of worker, each with its own
-- role, spots, tickets and rate — posted together under one post_id. Everything downstream (matching, bookings,
-- clock-in, pay, offers, weather, "same again") keeps working per shift. NULL = a shift that is its own post
-- (everything posted before this, and "same again tomorrow" clones).
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS post_id uuid;
CREATE INDEX IF NOT EXISTS shifts_post_idx ON shifts (post_id) WHERE post_id IS NOT NULL;
