-- Rollback: remove the per-entry ownership basis.
--
-- Refuses rather than silently breaking if any program still uses 'entries' —
-- restoring the old CHECK under such a row would fail anyway, and dropping the
-- program here would cascade its awards away, erasing paid history.

BEGIN;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.ownership_programs WHERE basis = 'entries';
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot roll back: % program(s) still use basis=''entries''. Deactivate and repoint them first.', n;
  END IF;
END $$;

ALTER TABLE public.ownership_programs
  DROP CONSTRAINT IF EXISTS ownership_programs_entries_scope_check;
ALTER TABLE public.ownership_programs
  DROP CONSTRAINT IF EXISTS ownership_programs_basis_check;
ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_basis_check
  CHECK (basis IN ('billing', 'collected', 'profit', 'fixed'));

DROP INDEX IF EXISTS public.cashbook_entries_created_by_at_idx;

COMMENT ON COLUMN public.ownership_rules.fixed_amount_inr IS NULL;
COMMENT ON COLUMN public.ownership_awards.basis_amount_inr IS NULL;
COMMENT ON COLUMN public.cashbook_entries.created_by IS NULL;

COMMIT;
