-- ============================================================================
-- ROLLBACK for 20260815100000_revoke_anon_and_secure_views.sql
-- ============================================================================
-- Restores the stock Supabase grants.
--
-- WARNING: running this re-opens an UNAUTHENTICATED read of company cash flow,
-- per-client billing totals, partner PII and payroll allocations to anyone
-- holding the public anon key — i.e. anyone who has loaded the site. Do not
-- run it to "unblock" a broken read path; find the path and grant it
-- specifically, or route it through the service role.
--
-- Provided only so the change is reversible on a controlled basis.
-- ============================================================================

BEGIN;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'm'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon', r.relname);
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;

DO $$
DECLARE
  targets text[] := ARRAY[
    'invoice_summary','monthly_cashbook_summary','allocation_audit_log',
    'mv_campaign_performance','mv_client_performance','mv_agency_benchmarks'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
