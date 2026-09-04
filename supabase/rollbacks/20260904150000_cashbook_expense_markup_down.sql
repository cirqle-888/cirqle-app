-- Rollback for 20260904150000_cashbook_expense_markup.
--
-- Dropping the columns loses every recorded cushion decision. Expense items
-- ALREADY copied onto invoices keep their own markup_type / markup_value —
-- those live on invoice_expense_items and are untouched by this rollback, so
-- no invoice changes value. Only the ability to set a cushion at entry time
-- goes away, and future auto-copies revert to billing at cost.
--
-- Revert the application code first: it writes these columns on insert and
-- update, and a write to a dropped column errors the whole entry save.

BEGIN;

ALTER TABLE public.cashbook_entries
  DROP CONSTRAINT IF EXISTS cashbook_entries_markup_type_check;

ALTER TABLE public.cashbook_entries
  DROP COLUMN IF EXISTS markup_type,
  DROP COLUMN IF EXISTS markup_value;

COMMIT;
