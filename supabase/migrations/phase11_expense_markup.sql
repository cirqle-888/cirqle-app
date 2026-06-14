-- Expense markup & rebill management
-- Extends invoice_expense_items with markup tracking fields.
-- original_amount = what was paid from cashbook
-- markup_*        = how it's being rebilled to the client
-- amount          = billing_amount (original + markup) — what the client sees

BEGIN;

ALTER TABLE invoice_expense_items
  ADD COLUMN IF NOT EXISTS original_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_amount_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS markup_type         TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS markup_value        NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS markup_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes               TEXT;

-- For existing rows (amount was already billing amount = original, no markup)
UPDATE invoice_expense_items
  SET original_amount = amount, original_amount_inr = amount_inr
  WHERE original_amount = 0;

-- Expand invoices.expenses_mode to support mode_a / mode_b / mode_c
-- (no CHECK constraint was added in phase10, so no constraint to drop)
-- Existing values 'combined'/'separate' fall through to mode_a in the app.

COMMIT;
