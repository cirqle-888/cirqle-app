-- Undo 20260814130000_package_first_cycle.sql
--
-- Dropping the column reverts every package to plain calendar-month billing.
-- Any extended opening cycle already invoiced stays as it was billed — invoice
-- lines are rows, not derivations.

BEGIN;

ALTER TABLE public.client_packages
  DROP CONSTRAINT IF EXISTS client_packages_first_cycle_after_start;

ALTER TABLE public.client_packages
  DROP COLUMN IF EXISTS first_cycle_end;

COMMIT;
