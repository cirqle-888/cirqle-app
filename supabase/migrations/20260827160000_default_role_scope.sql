-- ============================================================================
-- Close the two designations that fall through the visibility model
-- ============================================================================
-- Additive, idempotent, INSERT-only. Safe to re-run.
--
-- resolveServiceScopeMode (src/lib/scope/service-scope.ts) consults exactly
-- four keys and falls through to 'legacy' when none are held:
--
--     scope.view_all | tasks.view_all           → 'all'
--     scope.by_service | tasks.view_by_service  → 'services'
--     none of the above                         → 'legacy'
--
-- 'legacy' is NOT a restriction. filterTasksByVisibility returns the list
-- unfiltered for any mode that is not 'services', and visibleEmployeeIds
-- returns null (no narrowing). So a designation holding none of those four
-- keys sees every task and every colleague — silently, with nothing on screen
-- to suggest it.
--
-- Two designations were in that state. Both are empty right now, so this
-- changes nothing for anyone currently working; it fixes the paths people
-- arrive on.
--
--   Employee — its own description is "Default designation for new staff", so
--     the next hire would land there and get full visibility of every task and
--     every employee. Granted tasks.view_by_service, matching Designer: their
--     assigned services then decide what they see.
--
--   HR — genuinely needs the whole roster, and today gets it by ACCIDENT
--     rather than by grant. Granted scope.view_all so the outcome is identical
--     but legible: someone auditing Access & Roles can tell intent from
--     oversight. This is not a widening — HR could already see everything.
--
-- NOT ADDRESSED, deliberately: an employee with ZERO assigned services still
-- sees everyone even in 'services' mode. That is filterTasksByVisibility's
-- no-lockout rule ("a half-configured rollout must never lock anyone out"),
-- and reversing it belongs in the app, not in a permission grant. Practical
-- effect: assign a new hire's services as part of onboarding, or they are
-- unscoped until you do.
--
-- The 12 designations in 'all' mode (Accountant, Cashbook Entry, Auditor,
-- Reviewer, …) are untouched. Whether a cashbook-entry role should see every
-- task is a business question, not a defect.
-- ============================================================================

BEGIN;

WITH wanted(role_name, perm_key) AS (
  VALUES
    ('Employee', 'tasks.view_by_service'),
    ('HR',       'scope.view_all')
)
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM wanted w
  JOIN public.designations d ON d.name = w.role_name
  JOIN public.permissions  p ON p.key  = w.perm_key
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
