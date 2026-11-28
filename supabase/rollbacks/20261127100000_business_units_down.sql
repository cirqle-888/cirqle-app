-- Reverses 20261127100000_business_units.sql. Deletes every unit, its team,
-- agreement, invoice assignments and Cash Book tags, and the route-lock
-- function (so nobody is confined any more). Invoices, Cash Book entries and
-- employees themselves are untouched.
BEGIN;
DROP FUNCTION IF EXISTS public.my_unit_route_lock();
DROP TABLE IF EXISTS public.business_unit_settings;
DROP TABLE IF EXISTS public.business_unit_entries;
DROP TABLE IF EXISTS public.business_unit_invoices;
DROP TABLE IF EXISTS public.business_unit_partners;
DROP TABLE IF EXISTS public.business_unit_members;
DROP TABLE IF EXISTS public.business_units;
NOTIFY pgrst, 'reload schema';
COMMIT;
