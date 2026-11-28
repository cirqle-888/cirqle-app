-- ============================================================================
-- Unit staff: on a unit's team, but own work only
-- ============================================================================
-- Additive and idempotent. Needs 20261127100000_business_units.
--
-- A unit's team member (role 'member' or 'lead') sees the whole unit's work:
-- every task on its services, its clients, its social calendar. Some people
-- on a team are just staff — a designer who should see only the tasks given
-- to them. They get role 'staff':
--   · their unit gives them no services or clients of its own (the app then
--     shows only the tasks assigned to them or that they worked on, and the
--     requests assigned to them);
--   · they open fewer pages (My Work, Tasks, Requests, Chat, Prompt Studio);
--   · chat lines are unchanged: their own unit's team and admins.
--
-- my_unit_route_level() tells the sign-in check which of the two applies to
-- the CALLER: 'team', 'staff' or 'none'. Someone who is staff in one unit and
-- a member of another gets 'team'. my_unit_route_lock() is kept as it was.
--
-- Undo: rollbacks/20261128180000_unit_staff_role_down.sql
-- ============================================================================

BEGIN;

ALTER TABLE public.business_unit_members DROP CONSTRAINT IF EXISTS business_unit_members_role_check;
ALTER TABLE public.business_unit_members
  ADD CONSTRAINT business_unit_members_role_check CHECK (role IN ('lead', 'member', 'staff'));

CREATE OR REPLACE FUNCTION public.my_unit_route_level()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN COALESCE(bool_or(m.role <> 'staff'), FALSE) THEN 'team'
           WHEN COUNT(*) > 0 THEN 'staff'
           ELSE 'none'
         END
    FROM public.business_unit_members m
    JOIN public.business_units u ON u.id = m.unit_id AND u.is_active
    JOIN public.employees e ON e.id = m.employee_id
    LEFT JOIN public.designations d ON d.id = e.designation_id
   WHERE e.auth_id = auth.uid()
     AND COALESCE(d.is_admin, FALSE) = FALSE;
$$;
REVOKE ALL ON FUNCTION public.my_unit_route_level() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_unit_route_level() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
