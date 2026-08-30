-- Rollback for 20260830120000_employees_column_grants.
--
-- Restores the pre-migration state: `authenticated` holds every column of
-- `employees` again. That REOPENS the pay-and-bank-details exposure the
-- migration closed, so use it only to unbreak production, and re-apply as soon
-- as the import/export path is server-side.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO authenticated;

COMMIT;
