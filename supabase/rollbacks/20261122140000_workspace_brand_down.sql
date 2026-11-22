-- Undo 20261122140000_workspace_brand. Workspaces go back to showing every
-- brand; nothing else changes.
BEGIN;
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS brand_id;
NOTIFY pgrst, 'reload schema';
COMMIT;
