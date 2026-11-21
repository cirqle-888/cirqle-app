-- Undo 20261121200000_ad_projects_page_account.
-- Drops the column and its index. Any page chosen on a campaign is lost; the
-- campaigns themselves are untouched.
BEGIN;
DROP INDEX IF EXISTS public.ad_projects_page_account_idx;
ALTER TABLE public.ad_projects DROP COLUMN IF EXISTS page_account_id;
COMMIT;
