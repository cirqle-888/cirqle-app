-- Invoice Expense Items: bill cashbook outflow entries back to clients
-- Each cashbook outflow entry tagged to a client can be added to one invoice.
-- The UNIQUE constraint on cashbook_entry_id enforces "bill once" — removing
-- the row from this table makes the entry available again for a future invoice.

BEGIN;

CREATE TABLE IF NOT EXISTS invoice_expense_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  cashbook_entry_id  UUID NOT NULL REFERENCES cashbook_entries(id) ON DELETE RESTRICT,
  description        TEXT NOT NULL DEFAULT '',
  amount             NUMERIC(12,2) NOT NULL DEFAULT 0,     -- in invoice currency
  amount_inr         NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'INR',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cashbook_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_expense_items_invoice
  ON invoice_expense_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_expense_items_cashbook
  ON invoice_expense_items (cashbook_entry_id);

ALTER TABLE invoice_expense_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated all" ON invoice_expense_items
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- expenses_mode: how expenses appear on the invoice PDF
--   'combined'  → interspersed with task line items (increments the item counter)
--   'separate'  → rendered as a separate "Expenses" section below line items
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS expenses_mode TEXT NOT NULL DEFAULT 'combined';

COMMIT;
