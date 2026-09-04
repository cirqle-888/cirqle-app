-- ============================================================================
-- Cash Book expense markup ("cushion") — decide the rebill margin AT THE
-- MOMENT the client expense is recorded, not only later on the invoice.
--
-- WHY: a client-tagged outflow is auto-copied onto that client's draft invoice
-- by syncDraftInvoiceExpenses(), which has always written
-- markup_type = 'none' — billing the client exactly what we paid. The only
-- way to add a margin was to remember, later, to open the invoice and use Add
-- Expenses. Everything recorded and never revisited went out at cost.
--
-- These two columns let the entry itself carry the decision, so the auto-copy
-- applies it. They mirror invoice_expense_items.markup_type / markup_value
-- exactly, so both screens speak the same language.
--
-- markup_value is the raw input: a percentage for 'percentage', a flat amount
-- (in the ENTRY's own currency) for 'fixed'. The billed figure and the cushion
-- amount are derived (src/lib/finance/markup.ts), never stored here — the
-- derived pair already lives on invoice_expense_items.
--
-- Idempotent: IF NOT EXISTS on both columns, safe to re-run.
-- ============================================================================

ALTER TABLE public.cashbook_entries
  ADD COLUMN IF NOT EXISTS markup_type  text    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS markup_value numeric NOT NULL DEFAULT 0;

-- Constrain to the three values the app understands. Added separately (and
-- guarded) so re-running cannot fail on a duplicate constraint name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cashbook_entries_markup_type_check'
  ) THEN
    ALTER TABLE public.cashbook_entries
      ADD CONSTRAINT cashbook_entries_markup_type_check
      CHECK (markup_type IN ('none', 'percentage', 'fixed'));
  END IF;
END $$;

COMMENT ON COLUMN public.cashbook_entries.markup_type IS
  'Rebill cushion type for a client-tagged expense: none | percentage | fixed. Applied by syncDraftInvoiceExpenses when the entry is copied onto a draft invoice.';
COMMENT ON COLUMN public.cashbook_entries.markup_value IS
  'Raw cushion input — a percentage for markup_type=percentage, a flat amount in the entry currency for fixed. The billed total is derived, not stored.';
