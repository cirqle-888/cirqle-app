-- Reverses 20261128180000_unit_staff_role.sql. Staff become ordinary members
-- (they see their whole unit's work again), the narrower role check returns,
-- and the level function goes; the sign-in check falls back to
-- my_unit_route_lock().
BEGIN;
UPDATE public.business_unit_members SET role = 'member' WHERE role = 'staff';
ALTER TABLE public.business_unit_members DROP CONSTRAINT IF EXISTS business_unit_members_role_check;
ALTER TABLE public.business_unit_members
  ADD CONSTRAINT business_unit_members_role_check CHECK (role IN ('lead', 'member'));
DROP FUNCTION IF EXISTS public.my_unit_route_level();
NOTIFY pgrst, 'reload schema';
COMMIT;
