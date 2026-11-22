-- Undo 20261122160000_workspace_brand_restrict. Members are no longer confined;
-- brand workspaces still SHOW their brand.
BEGIN;
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS restrict_members;
NOTIFY pgrst, 'reload schema';
COMMIT;
