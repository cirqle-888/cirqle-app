-- ============================================================================
-- Chat across business-unit lines
-- ============================================================================
-- Idempotent. Needs 20261127100000_business_units and 20261124100000_chat_upgrade.
--
-- A non-admin on a unit's team (Social Media & Creative, Cirqle Flyers,
-- Memoura…) talks only with their own unit and with admins. The app already
-- refuses the rest (lib/chat/access.ts → blockedByUnitLine). This makes the
-- DATABASE refuse it too, so live updates (Realtime) and anything read with a
-- person's own session follow the same line: every chat policy goes through
-- is_conversation_member(), and that now also asks chat_unit_blocked().
--
-- chat_unit_blocked(conversation, person) is TRUE only when the person is a
-- non-admin member of an active unit AND:
--   · the conversation is a department channel of a department outside their
--     units, or
--   · any other non-admin member stands across the line: on no unit they share,
--     and no person-level chat rule (Settings → Chat access) on either side
--     says "Everyone" or names the other.
-- Admins-only (announcement) conversations are never blocked.
--
-- Everyone not on a unit's team is untouched: the function returns FALSE at
-- its first step for them.
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

-- Membership check used by every chat policy (migration 015). Same as before,
-- plus the unit line.
CREATE OR REPLACE FUNCTION public.is_conversation_member(conv_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_members
     WHERE conversation_id = conv_id AND employee_id = public.current_employee_id()
  )
  AND NOT public.chat_unit_blocked(conv_id, public.current_employee_id())
$$;

COMMIT;
