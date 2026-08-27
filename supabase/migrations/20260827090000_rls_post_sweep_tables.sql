-- ============================================================================
-- DB-01 follow-up — RLS on the 13 tables created after the 2026-08-01 sweep
-- ============================================================================
--
-- WHY THESE THIRTEEN, AND ONLY THESE
-- 20260801110000_rls_all_tables.sql enabled RLS on every public table that
-- lacked it AT THE MOMENT IT RAN, by scanning pg_tables. It is therefore a
-- point-in-time sweep, not a standing rule: anything created afterwards starts
-- with RLS off again. Four migrations landed the following week and none
-- enabled it, which is what the `security` CI job has been failing on since:
--
--   20260807090000_financial_core.sql
--     overhead_allocation_policy, payroll_adjustments, period_locks,
--     profit_snapshots, recurring_expenses
--   20260807100000_ownership_platform.sql
--     org_units, org_unit_members, org_unit_scopes,
--     ownership_programs, ownership_rules, ownership_awards
--   20260807110000_offer_campaign_revisions.sql   offer_campaign_revisions
--   20260807120000_figma_events.sql               figma_events
--
-- NO POLICY IS CREATED, AND THAT IS THE POINT
-- The house pattern so far has been `FOR ALL TO authenticated USING (true)`,
-- which 20260801100000 itself describes as "a floor, not the final model" —
-- it existed to close a live anon hole on tables the browser genuinely reads.
--
-- These thirteen are different: EVERY access path is the service role, which
-- bypasses RLS entirely. Verified before writing this, three ways:
--   • no 'use client' module references any of them
--   • no module reaching them imports @/lib/supabase/client
--   • no module reaching them uses the RLS-respecting server client either —
--     every one goes through createAdminClient()
--   • none are in a realtime publication and nothing subscribes to them
--
-- So RLS with NO permissive policy is both the tightest and the safest option:
-- anon and authenticated get nothing, the application is untouched. Adding
-- `USING (true)` here would grant reads that no code performs — payroll
-- adjustments, profit snapshots and ownership awards to every logged-in
-- employee — purely to make CI green. That is the opposite of the intent.
--
-- Grants are revoked as well. With RLS on and no policy the effect is already
-- nil, but a future `CREATE POLICY` on one of these should have to restore
-- access deliberately rather than inherit it from a schema-wide grant.
--
-- Idempotent and transactional. Re-running is a no-op; a table absent from
-- this database is skipped rather than erroring.
-- Rollback: supabase/rollbacks/20260827090000_rls_post_sweep_tables_down.sql
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    -- financial_core
    'overhead_allocation_policy',
    'payroll_adjustments',
    'period_locks',
    'profit_snapshots',
    'recurring_expenses',
    -- ownership_platform
    'org_units',
    'org_unit_members',
    'org_unit_scopes',
    'ownership_programs',
    'ownership_rules',
    'ownership_awards',
    -- standalone
    'offer_campaign_revisions',
    'figma_events'
  ];
BEGIN
  FOREACH t IN ARRAY targets
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'skipped % (not present in this database)', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);

    RAISE NOTICE 'secured % (RLS on, no policy — service role only)', t;
  END LOOP;
END $$;

COMMIT;
