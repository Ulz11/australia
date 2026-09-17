-- 012: the tögrög amount comes from a live AUD → MNT rate, not a fixed setting.
--
-- lib/fxRate.ts asks the Bank of Mongolia for its official daily rate (then a public rates API if that fails,
-- then AUD_MNT_RATE), and keeps what it got here for 6 hours so serverless instances don't each ask again.
-- A QPay invoice keeps the rate it was raised at, where that rate came from and which day it was for, and the
-- Sydney day it was raised: a still-open QR is reused for the rest of that day whatever the rate does since,
-- and raised again only on a new day or when the invoice's AUD total no longer matches it.
-- Additive and idempotent — migrate.ts re-runs every file.

------------------------------------------------------------------ the rate cache
CREATE TABLE IF NOT EXISTS fx_rates (
  pair       text        NOT NULL,                   -- 'AUD/MNT': tögrög per 1 Australian dollar
  rate       numeric     NOT NULL CHECK (rate > 0),
  source     text        NOT NULL,                   -- 'mongolbank' | 'fallback' (an AUD_MNT_RATE setting is never cached)
  as_of      date        NOT NULL,                   -- the day the source says the rate is for
  fetched_at timestamptz NOT NULL DEFAULT now(),     -- when we last asked; fresh for 6 hours
  PRIMARY KEY (pair, as_of, source)
);
CREATE INDEX IF NOT EXISTS fx_rates_fetched_idx ON fx_rates (pair, fetched_at DESC);

------------------------------------------------------------------ the rate a QPay invoice was raised at
-- qpay_rate (011) already holds the number.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_rate_source text;      -- 'mongolbank' | 'fallback' | 'env'
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_rate_as_of  date;      -- the day that rate is for
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_raised_on   date;      -- the Sydney day the linked QPay invoice was raised
