-- Reverses 20261128160000_unit_office_staff.sql. Forgets who is marked as
-- office staff; nobody's permissions change (they live on their role).
BEGIN;
DROP TABLE IF EXISTS public.business_unit_office_staff;
NOTIFY pgrst, 'reload schema';
COMMIT;
