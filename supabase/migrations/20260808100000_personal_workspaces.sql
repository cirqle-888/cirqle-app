-- ═══════════════════════════════════════════════════════════════════════════
-- PERSONAL WORKSPACES — employees design their own UI context.
--
-- Workspaces are UI-only (sidebar/widgets/landing; migration 022's header:
-- "ONLY changes navigation/UI, never permissions"), and the sidebar applies
-- the permission filter BEFORE the workspace filter — so letting an employee
-- curate their own workspace is safe by construction: they can only SUBTRACT
-- from what their designation already permits, never reveal anything.
--
-- Model: workspaces.owner_employee_id
--   • NULL     → a SHARED workspace, administered by workspaces.manage
--                holders exactly as before (and the is_system row).
--   • not null → a PERSONAL workspace: created, edited and deleted by its
--                owner alone; its only member is the owner (enforced in the
--                server actions, which are the sole write path — writes are
--                REVOKEd at the DB level by 022).
--
-- Personal workspaces also get a workspace_members row for the owner, so
-- every existing membership-based read (visibility filter, switch guard,
-- getMyWorkspaceState) works on them with no special cases.
--
-- ADDITIVE + idempotent. Rollback:
-- supabase/rollbacks/20260808100000_personal_workspaces_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS owner_employee_id UUID
    REFERENCES public.employees(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.workspaces.owner_employee_id IS
  'NULL = shared workspace (admin-managed). Set = personal workspace, editable only by its owner. UI-only either way — workspaces never gate data.';

CREATE INDEX IF NOT EXISTS workspaces_owner_idx
  ON public.workspaces (owner_employee_id) WHERE owner_employee_id IS NOT NULL;

-- Owners can read their own workspace even before the member row lands
-- (creation writes both in one action, but the policy should not depend on
-- that ordering).
DROP POLICY IF EXISTS workspaces_select ON public.workspaces;
CREATE POLICY workspaces_select ON public.workspaces FOR SELECT
  USING (
    is_system                              -- "All Workspace" always visible
    OR is_current_employee_admin()         -- admins see every workspace
    OR owner_employee_id = current_employee_id()
    OR EXISTS (SELECT 1 FROM public.workspace_members wm
                WHERE wm.workspace_id = id AND wm.employee_id = current_employee_id())
  );

COMMIT;
