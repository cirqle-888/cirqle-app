-- ============================================================================
-- Grant contributions.view_own to the roles that were reaching the
-- Contributions page without any permission at all.
--
-- WHY: the page, its nav item and its route were completely ungated. Anyone
-- signed in could open Contributions, and `contributions.view_own` — counted
-- in a designation's "Contributions 0/6" on the Access & Roles screen — was
-- never checked by it. The data itself was safe (rows are stripped to the
-- viewer's own and earnings are withheld at the query), but the toggle
-- promised a gate that did not exist.
--
-- The application now gates the nav item, the route and the page on ANY rung
-- of the ladder — view_own, view_unit or view_all. Designer and Client
-- Success held none of the three despite using the page daily, so they are
-- granted the lowest rung: their own rows, which is their own work record and
-- the basis of their earnings.
--
-- NOT granted here, deliberately:
--   · Task Manager and Auditor already hold view_all — they reach the page on
--     a higher rung, and adding view_own would say nothing new.
--   · Every designation with no employees keeps whatever it has; turning the
--     page on for a role nobody holds is a decision for whoever fills it.
--
-- Idempotent: ON CONFLICT DO UPDATE, safe to re-run.
-- ============================================================================

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE p.key = 'contributions.view_own'
   AND d.is_admin = FALSE
   AND d.name IN ('Designer', 'Client Success & Social Media Executive')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
