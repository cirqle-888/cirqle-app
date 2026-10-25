-- Hotfix for 20261016100000_cashbook_reversals.
--
-- That migration gave `released_by_entry_id` on both allocation tables a
-- foreign key to cashbook_entries. Each table then had TWO relationships to
-- cashbook_entries (cashbook_entry_id and released_by_entry_id), and
-- PostgREST refuses an embed it cannot disambiguate:
--
--   PGRST201 Could not embed because more than one relationship was found
--   for 'cashbook_entries' and 'cashbook_invoice_allocations'
--
-- Every `allocations:cashbook_invoice_allocations(...)` /
-- `payroll_allocations:cashbook_payroll_allocations(...)` embed under an entry
-- — the Cash Book list among them — failed until this ran.
--
-- The column stays; only its constraint goes. It is written solely by the
-- reversal action with the id of the row it has just inserted, and read back
-- by equality, so the constraint added nothing the code relies on.
-- Safe to re-run.

BEGIN;

-- Whatever the constraints are called, drop every foreign key on
-- released_by_entry_id in the two allocation tables.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f'
       AND a.attname = 'released_by_entry_id'
       AND c.conrelid IN ('public.cashbook_invoice_allocations'::regclass,
                          'public.cashbook_payroll_allocations'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

COMMIT;

-- PostgREST caches relationships; make it re-read them now.
NOTIFY pgrst, 'reload schema';
