-- Rollback for 20260814110000_client_packages.sql
--
-- DESTRUCTIVE: drops the package tables and every row in them. Any task linked
-- to a package loses that link (the column goes with the table's FK), and any
-- invoice fee line loses its package_id — the LINE ITSELF SURVIVES, so an
-- already-issued invoice keeps its total. Only run this if packages are being
-- abandoned entirely.
--
-- Order matters: the referencing columns must go before the tables they point at.

BEGIN;

DROP INDEX IF EXISTS public.invoice_items_package_uniq;
ALTER TABLE public.invoice_items DROP COLUMN IF EXISTS package_id;

DROP INDEX IF EXISTS public.tasks_package_idx;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS package_id;

DROP TABLE IF EXISTS public.client_package_items;
DROP TABLE IF EXISTS public.client_packages;

-- Permissions. designation_permissions rows cascade from permissions.
DELETE FROM public.permissions WHERE key IN ('packages.view','packages.manage');

COMMIT;
