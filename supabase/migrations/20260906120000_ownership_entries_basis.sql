-- Ownership: a per-entry basis for cash-book data entry.
--
-- Every existing basis measures MONEY over a period and every rule takes a
-- percentage of it. Recording cash-book rows is not like that: an income row
-- and an expense row are the same work, and the rupee value of a row says
-- nothing about the effort of typing it. Measured against 37 months of live
-- data, a percentage of net cash-book value would have paid ₹0 in 12 of them —
-- including months with 18-19 entries typed. So this basis measures a COUNT.
--
-- Two consequences that the application code depends on:
--   * `ownership_awards.basis_amount_inr` holds a ROW COUNT, not rupees, when
--     basis = 'entries'. (That column has no CHECK, so old snapshots are safe.)
--   * `ownership_rules.fixed_amount_inr` is the rate PER UNIT rather than a
--     flat amount. See the column comment below.
--
-- Forward-only by necessity: `cashbook_entries.created_by` was NULL on every
-- pre-existing row, so there is no past to backfill. To reward past work, add a
-- one-time 'fixed'-basis program instead — that needs no code.

BEGIN;

-- The inline CHECK from 20260807100000 got an auto-generated name. Drop it by
-- looking it up rather than guessing, then re-add it under a known name.
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.ownership_programs'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%basis%'
     AND pg_get_constraintdef(oid) ILIKE '%billing%'
   LIMIT 1;
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ownership_programs DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_basis_check
  CHECK (basis IN ('billing', 'collected', 'profit', 'fixed', 'entries'));

-- A row count has no client, service or team dimension to slice by.
ALTER TABLE public.ownership_programs
  DROP CONSTRAINT IF EXISTS ownership_programs_entries_scope_check;
ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_entries_scope_check
  CHECK (basis <> 'entries' OR scope_kind = 'company');

COMMENT ON COLUMN public.ownership_rules.fixed_amount_inr IS
  'Flat rupees for the period — EXCEPT on a per-unit basis (program.basis = ''entries''), where it is the rupee rate PER UNIT. Interpret it against the parent program''s basis, exactly as `percent` must be.';

COMMENT ON COLUMN public.ownership_awards.basis_amount_inr IS
  'What the award was measured on: rupees on a money basis, a ROW COUNT when basis = ''entries''.';

COMMENT ON COLUMN public.cashbook_entries.created_by IS
  'The employee who hand-typed this row. NULL for machine-written rows (cron postings, CSV imports, invoice-payment and salary auto-entries, shared-token API writes) and for the generated copies of a recurring series — which is what keeps them out of the per-entry ownership count.';

-- Matches the counting query's exact predicate.
CREATE INDEX IF NOT EXISTS cashbook_entries_created_by_at_idx
  ON public.cashbook_entries (created_by, created_at)
  WHERE deleted_at IS NULL AND created_by IS NOT NULL;

COMMIT;
