-- ============================================================================
-- Chat: unit teams and Cirqle's office team may talk
-- ============================================================================
-- Idempotent. Needs 20261128100000_chat_unit_lines and
-- 20261128160000_unit_office_staff.
--
-- A unit's team talks only with its own unit and admins. The office team
-- (Departments & Brands → Cirqle HQ → Office team — accounts, task handling)
-- works with every unit, so it no longer counts as "across the line": a group
-- or direct chat with an office-team member stays open to the unit member.
-- The app does the same (lib/chat/access.ts → crossesUnitLine).
--
-- Only chat_unit_blocked() changes: one more "never blocks" check beside the
-- admin one. Everything else is as in 20261128100000_chat_unit_lines.
-- Undo: rollbacks/20261128190000_chat_office_team_down.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.chat_unit_blocked(conv_id uuid, emp_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_units AS (
    SELECT m.unit_id, u.category_ids
      FROM public.business_unit_members m
      JOIN public.business_units u ON u.id = m.unit_id AND u.is_active
      JOIN public.employees e ON e.id = m.employee_id
      LEFT JOIN public.designations d ON d.id = e.designation_id
     WHERE m.employee_id = emp_id
       AND COALESCE(d.is_admin, FALSE) = FALSE
  ),
  conv AS (
    SELECT c.department_id, c.posting FROM public.conversations c WHERE c.id = conv_id
  )
  SELECT CASE
    WHEN emp_id IS NULL OR NOT EXISTS (SELECT 1 FROM my_units) THEN FALSE
    WHEN (SELECT posting FROM conv) = 'admins' THEN FALSE
    WHEN (SELECT department_id FROM conv) IS NOT NULL THEN NOT EXISTS (
      SELECT 1 FROM my_units WHERE (SELECT department_id FROM conv) = ANY (my_units.category_ids)
    )
    ELSE EXISTS (
      SELECT 1
        FROM public.conversation_members cm
        JOIN public.employees oe ON oe.id = cm.employee_id
        LEFT JOIN public.designations od ON od.id = oe.designation_id
       WHERE cm.conversation_id = conv_id
         AND cm.employee_id <> emp_id
         AND COALESCE(od.is_admin, FALSE) = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM public.business_unit_office_staff os WHERE os.employee_id = cm.employee_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.business_unit_members b
             JOIN my_units mu ON mu.unit_id = b.unit_id
            WHERE b.employee_id = cm.employee_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.chat_access_rules r
            WHERE r.subject_type = 'employee'
              AND (
                (r.subject_id = cm.employee_id AND (r.mode = 'everyone' OR emp_id = ANY (r.employee_ids)))
                OR (r.subject_id = emp_id AND (r.mode = 'everyone' OR cm.employee_id = ANY (r.employee_ids)))
              )
         )
    )
  END
$$;

REVOKE ALL ON FUNCTION public.chat_unit_blocked(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_unit_blocked(uuid, uuid) TO authenticated;

COMMIT;
