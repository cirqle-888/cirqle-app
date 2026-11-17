-- ============================================================================
-- Work money, step 1 of 2 — permission-checked views for prices and earnings
-- ============================================================================
--
-- THE PROBLEM
-- `tasks` and `contribution_scores` are read rule "is signed in" (migration
-- 006). The app strips the money before it reaches the screen, but the anon
-- key plus any employee's session reads the tables directly — so anyone can
-- open the browser console and pull every task's price and every colleague's
-- earnings. Not theoretical: a Designer's login is enough.
--
-- THE FIX — the same shape as the employees salary fix (20260830120000)
--   Step 1 (this file, additive, safe to apply any time):
--     * can_see_work_money() — true for anyone holding a permission that
--       already shows these figures on screen: tasks.view_pricing,
--       contributions.view_earnings, billing.view_invoices, payroll.view.
--       has_permission() is true for admin designations.
--     * tasks_priced / contribution_scores_priced — read-only views that
--       return rows only when can_see_work_money() is true.
--     The app reads every price and earning through these views
--     (src/lib/supabase/priced.ts), and falls back to the base tables while
--     this file is not applied yet.
--   Step 2 (20261116120000): withhold the money columns of the base tables
--     from `authenticated`. Apply it ONLY after this file is applied AND the
--     code that reads through these views is deployed.
--
-- WHY THE VIEWS RUN AS THEIR OWNER (security_invoker = false)
-- After step 2 the browser role cannot read the money columns of the base
-- tables, so an invoker view would fail. The view's own WHERE is the gate
-- instead. The views are SELECT-only for `authenticated`: an owner-rights view
-- that accepted writes would bypass the base tables' write policies.
--
-- Idempotent. Transactional.
-- Rollback: supabase/rollbacks/20261116110000_work_money_views_down.sql
--
-- Verify after applying (as a NON-money employee in the browser console):
--   await supabase.from('tasks_priced').select('id').limit(1)               → []
-- and as an admin:                                                          → one row
--   SELECT has_table_privilege('authenticated','public.tasks_priced','INSERT'); → false
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.can_see_work_money()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT has_permission(auth.uid(), 'tasks.view_pricing')
      OR has_permission(auth.uid(), 'contributions.view_earnings')
      OR has_permission(auth.uid(), 'billing.view_invoices')
      OR has_permission(auth.uid(), 'payroll.view')
$$;

REVOKE ALL ON FUNCTION public.can_see_work_money() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_work_money() TO authenticated;

-- (SELECT …) makes Postgres evaluate the check once per query, not per row.
CREATE OR REPLACE VIEW public.tasks_priced
  WITH (security_invoker = false, security_barrier = true) AS
  SELECT t.* FROM public.tasks t
  WHERE (SELECT public.can_see_work_money());

CREATE OR REPLACE VIEW public.contribution_scores_priced
  WITH (security_invoker = false, security_barrier = true) AS
  SELECT s.* FROM public.contribution_scores s
  WHERE (SELECT public.can_see_work_money());

REVOKE ALL ON public.tasks_priced, public.contribution_scores_priced FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tasks_priced, public.contribution_scores_priced TO authenticated;

-- PostgREST caches the schema; without this the new views 404 until restart.
NOTIFY pgrst, 'reload schema';

COMMIT;
