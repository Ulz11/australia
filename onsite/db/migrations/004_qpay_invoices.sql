-- 004: QPay invoices. One row per invoice we raise. The callback can only ever flip a row we already hold,
-- and only after QPay's own /payment/check says it's paid.
CREATE TABLE IF NOT EXISTS qpay_invoices (
  sender_invoice_no text PRIMARY KEY,                         -- ours; QPay rejects repeats
  qpay_invoice_id   text UNIQUE,                              -- theirs, set once the invoice exists
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose           text NOT NULL,                            -- 'match_fee' | 'subscription' | ...
  amount_mnt        integer NOT NULL CHECK (amount_mnt > 0),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled','failed')),
  payment_id        text,
  paid_amount_mnt   integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  last_checked_at   timestamptz                               -- throttles QPay /payment/check to one per invoice per 10 s
);
ALTER TABLE qpay_invoices ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;   -- migrate.ts re-runs this file; keep it additive
CREATE INDEX IF NOT EXISTS qpay_invoices_user ON qpay_invoices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS qpay_invoices_open ON qpay_invoices (created_at) WHERE status = 'open';
