-- 011: an OnSite invoice is paid through QPay, and only through QPay.
--
-- The boss taps "Pay with QPay" on an open invoice. Only then is a QPay invoice raised (lib/invoiceQpay.ts):
-- the AUD total at AUD_MNT_RATE, rounded up to whole tögrög. The OnSite invoice points at the QPay invoice
-- that can pay it, and remembers the tögrög amount and the rate it was raised at, so a later tap at the same
-- amount reuses it and a tap after the rate moved cancels it and raises a new one. When settleInvoice
-- (lib/billing.ts) flips that QPay invoice to paid, the same statement marks this invoice paid.
-- Additive and idempotent — migrate.ts re-runs every file.

------------------------------------------------------------------ the link, on the OnSite invoice
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_sender_invoice_no text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_amount_mnt        bigint;        -- whole tögrög the linked QPay invoice asks for
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_rate              numeric;       -- tögrög per 1 AUD it was raised at
-- A short lease while one tap talks to QPay, so two taps at once can't raise two QPay invoices. Never held
-- across a database transaction (QPay can take seconds); a lease older than 3 minutes is a crashed tap.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qpay_claimed_at        timestamptz;

-- ADD COLUMN IF NOT EXISTS won't add a constraint to a column that is already there, so ask pg_constraint.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_qpay_sender_invoice_no_fkey') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_qpay_sender_invoice_no_fkey
      FOREIGN KEY (qpay_sender_invoice_no) REFERENCES qpay_invoices(sender_invoice_no);
  END IF;
END $$;

-- One QPay invoice pays at most one OnSite invoice, and settling finds it by this.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_qpay_link_idx ON invoices(qpay_sender_invoice_no) WHERE qpay_sender_invoice_no IS NOT NULL;

------------------------------------------------------------------ what the payer needs, on the QPay invoice
-- QPay hands back the QR image, its short link and a deep link per bank app only when the invoice is raised;
-- GET /invoice/{id} doesn't return them again. So they are kept while the invoice can be paid, and cleared
-- the moment it is paid or cancelled.
ALTER TABLE qpay_invoices ADD COLUMN IF NOT EXISTS qr jsonb;

COMMENT ON COLUMN qpay_invoices.purpose IS 'what the money is for: onsite_invoice (an OnSite invoice, linked from invoices.qpay_sender_invoice_no), or a test';
