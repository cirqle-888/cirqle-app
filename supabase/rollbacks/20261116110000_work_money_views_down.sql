-- Removes the priced views. Roll back 20261116120000 FIRST if it is applied:
-- without these views and without the column grants, price-allowed staff can
-- no longer read prices in the browser.
BEGIN;
DROP VIEW IF EXISTS public.tasks_priced;
DROP VIEW IF EXISTS public.contribution_scores_priced;
DROP FUNCTION IF EXISTS public.can_see_work_money();
NOTIFY pgrst, 'reload schema';
COMMIT;
