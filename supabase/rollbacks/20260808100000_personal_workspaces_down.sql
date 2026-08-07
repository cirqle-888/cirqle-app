-- Rollback for 20260808100000_personal_workspaces.sql
-- Deletes every personal workspace (the column is their identity), restores
-- the original select policy from migrations/022_workspaces.sql. Anyone whose
-- current workspace was personal falls back via employees.current_workspace_id
-- ON DELETE SET NULL → "All Workspace".

BEGIN;

DELETE FROM public.workspaces WHERE owner_employee_id IS NOT NULL;

DROP POLICY IF EXISTS workspaces_select ON public.workspaces;
CREATE POLICY workspaces_select ON public.workspaces FOR SELECT
  USING (
    is_system
    OR is_current_employee_admin()
    OR EXISTS (SELECT 1 FROM public.workspace_members wm
                WHERE wm.workspace_id = id AND wm.employee_id = current_employee_id())
  );

DROP INDEX IF EXISTS public.workspaces_owner_idx;
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS owner_employee_id;

COMMIT;
