-- ============================================================================
-- Work money, step 2 of 2 — the browser role loses the money columns
-- ============================================================================
--
-- Apply ONLY when both are true:
--   1. 20261116110000_work_money_views is applied, and
--   2. the code that reads prices through those views is deployed
--      (src/lib/supabase/priced.ts; guarded by
--      src/lib/permissions/work-money-browser.test.ts).
-- Applied early, every price-allowed screen that reads from the browser
-- (Tasks, Invoices, Payroll, Contributions) fails to load prices.
--
-- WHAT IT DOES
-- `authenticated` keeps SELECT on every column of `tasks` and
-- `contribution_scores` EXCEPT the money ones listed below. A partial column
-- grant can only be expressed as "revoke the table, grant the columns", so the
-- grant list is computed from the live catalogue rather than hand-written.
--
-- Rows are untouched: non-money employees still read, create and update tasks
-- from the browser exactly as before. They simply cannot ask for a price.
--
-- A COLUMN ADDED LATER is not granted automatically. If browser code needs it,
-- add it with `GRANT SELECT (new_col) ON public.tasks TO authenticated;` — and
-- if it carries money, add it to the lists here and in
-- src/lib/permissions/strip.ts TASK_PRICING_FIELDS instead.
--
-- INSERT and UPDATE are unchanged (table-level), so the browser can still
-- write a price it is allowed to set; it just cannot read one back.
--
-- Idempotent. Transactional.
-- Rollback: supabase/rollbacks/20261116120000_work_money_column_grants_down.sql
--
-- Verify after applying:
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE grantee = 'authenticated' AND table_name = 'tasks' AND privilege_type = 'SELECT'
--     AND column_name IN ('billing_amount','billing_amount_inr');            → 0 rows
--   and as a non-money employee in the browser console:
--   await supabase.from('tasks').select('billing_amount_inr').limit(1)     → permission denied
-- ============================================================================

BEGIN;

DO $$
DECLARE
  task_money  text[] := ARRAY[
    'billing_amount', 'billing_amount_inr', 'billing_exchange_rate', 'billing_percent',
    'billing_snapshot', 'billing_rule', 'loss_amount', 'work_value', 'work_value_inr',
    'referral_percent'
  ];
  score_money text[] := ARRAY['earnings_inr'];
  cols text;
BEGIN
  -- tasks
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tasks' AND NOT (column_name = ANY (task_money));
  EXECUTE 'REVOKE SELECT ON public.tasks FROM authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.tasks TO authenticated', cols);

  -- contribution_scores
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'contribution_scores' AND NOT (column_name = ANY (score_money));
  EXECUTE 'REVOKE SELECT ON public.contribution_scores FROM authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.contribution_scores TO authenticated', cols);
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
