-- ============================================================================
-- Close the last 18 tables with row-level security switched off
-- ============================================================================
--
-- THE GAP (measured against production, 2026-08-29)
-- 18 of the 172 tables in `public` had rowsecurity = false AND a SELECT grant
-- to `authenticated`. RLS off plus a role grant means the table is readable in
-- full by anyone holding a login — from the browser console, via PostgREST, with
-- no permission check and no audit trail. Among them:
--
--   cashbook_payroll_allocations   what each employee was paid
--   deductions                     payroll deductions
--   invoice_change_logs            who changed which invoice
--   ad_*                           campaign spend, AI cost and forecast data
--
-- This is NOT the anonymous hole: 20260815100000 revoked anon across the schema
-- and that is verified applied (scripts/sweep-anon.mjs reports 0). The exposure
-- here is every logged-in employee, which is a smaller blast radius and still
-- the wrong default.
--
-- It is also why the CI `security` job has failed on every push: scripts/
-- check-rls.sql returns exactly this set, and a non-empty result fails the job.
--
-- ── HOW THE TWO GROUPS WERE DECIDED ─────────────────────────────────────────
--
-- Enabling RLS on a table with no policy denies it to `authenticated` outright,
-- while `service_role` bypasses RLS entirely. So the only question per table is:
-- does anything reach it as `authenticated`? Three ways that can happen, and all
-- three are what scripts/rls-keep-list.mjs enumerates:
--
--   1. a browser component querying it with the anon-key client,
--   2. a Realtime postgres_changes subscription (RLS is evaluated per subscriber),
--   3. a server module reading it through `await createClient()`, the
--      cookie-session client, which connects as `authenticated` rather than as
--      the service role.
--
-- Group A below is the intersection of the 18 with that derived list; group B is
-- the remainder. Every table in group B was additionally confirmed by a second,
-- independent grep for `.from('<table>')` in any module importing the browser
-- client, to avoid resting a production change on one heuristic.
--
-- Group A keeps a permissive `USING (true)` policy. That is deliberately NOT an
-- improvement in itself — it reproduces exactly the access these tables have
-- today, so this migration cannot change application behaviour. What it buys is
-- the mechanism: RLS is now ON, so tightening any one of them later is editing a
-- policy rather than re-litigating whether RLS can be enabled at all. Scoping
-- them properly needs per-table ownership rules and is tracked separately.
--
-- Idempotent. Transactional: applies completely or not at all.
-- Rollback: supabase/rollbacks/20260830100000_rls_close_remaining_tables_down.sql
-- ============================================================================

BEGIN;

-- ── GROUP A: reached by `authenticated` — RLS on, access preserved ──────────
DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'cashbook_categories',          -- settings/page.tsx, cookie-session client
    'cashbook_payroll_allocations', -- browser: allocation modal
    'contribution_groups',          -- browser + settings/page.tsx
    'invoice_change_logs',          -- browser: invoice detail
    'quotation_items',              -- browser: quotations
    'task_tools',                   -- browser: tasks
    'tool_services'                 -- browser + settings/page.tsx
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
        t || '_authenticated', t);
      RAISE NOTICE 'RLS on, access preserved: %', t;
    ELSE
      RAISE NOTICE 'skipped (absent): %', t;
    END IF;
  END LOOP;
END $$;

-- ── GROUP B: service-role only — RLS on, no policy, therefore deny-all ──────
DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'ad_accounts',
    'ad_ai_cache',
    'ad_ai_insights',
    'ad_ai_usage',
    'ad_benchmarks',
    'ad_businesses',
    'ad_forecast_accuracy',
    'ad_sync_logs',
    'ai_prompts',
    'deductions',
    'parameter_services'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      RAISE NOTICE 'RLS on, deny-all for authenticated: %', t;
    ELSE
      RAISE NOTICE 'skipped (absent): %', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
