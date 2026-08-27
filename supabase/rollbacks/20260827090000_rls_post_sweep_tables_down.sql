-- ============================================================================
-- ROLLBACK for 20260827090000_rls_post_sweep_tables.sql
-- ============================================================================
-- Returns the thirteen tables to their pre-migration state: RLS off, and the
-- schema-wide grants they previously inherited restored to authenticated.
--
-- WARNING: this re-opens payroll_adjustments, profit_snapshots, period_locks,
-- overhead_allocation_policy and the ownership_* tables — salary adjustments,
-- company profit figures and equity awards — to anyone holding a valid session
-- token, and re-exposes them to the anon key wherever a schema-wide grant
-- still reaches. The forward migration was verified not to affect any
-- application path (every reader is the service role, which ignores RLS), so
-- a broken flow is far more likely to have another cause. Establish that
-- first, and re-apply as soon as it is fixed.
--
-- anon is deliberately NOT re-granted: 20260815100000 revoked it globally and
-- restoring it here would undo a separate security migration.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'overhead_allocation_policy','payroll_adjustments','period_locks',
    'profit_snapshots','recurring_expenses',
    'org_units','org_unit_members','org_unit_scopes',
    'ownership_programs','ownership_rules','ownership_awards',
    'offer_campaign_revisions','figma_events'
  ];
BEGIN
  FOREACH t IN ARRAY targets
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END $$;

COMMIT;
