-- Rollback for 20260831090000_billing_view_totals.
--
-- Removes the grants and the permission row. The UI reads the key by name, so
-- with the row gone `billing.view_totals` is simply held by nobody and the
-- portfolio aggregates hide for everyone — including admins, who bypass the
-- check in code rather than through this table.
--
-- Only run this alongside reverting the application code that reads the key.

BEGIN;

DELETE FROM public.designation_permissions
WHERE permission_id IN (SELECT id FROM public.permissions WHERE key = 'billing.view_totals');

DELETE FROM public.permissions WHERE key = 'billing.view_totals';

COMMIT;
