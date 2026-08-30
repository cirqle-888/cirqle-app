-- ============================================================================
-- ROLLBACK for 20260815110000_authenticated_least_privilege.sql
-- ============================================================================
-- Restores the blanket `authenticated` grant on every relation, and the
-- whole-row grant on employees.
--
-- WARNING: this re-opens direct browser access to provider_connections (OAuth
-- tokens), bank_accounts, company_settings (offer_sheet_secret), payslip_emails,
-- ownership_awards, business_partners, audit_log — and to every colleague's
-- base_salary, hourly_rate, bank_details and date_of_birth.
--
-- If a screen broke after the migration, the fix is almost always to add that
-- ONE relation back (see below) rather than to run this file.
--
--   GRANT SELECT ON public.<relation> TO authenticated;
--
-- and then add it to scripts/rls-keep-list.mjs so the next regeneration keeps it.
-- ============================================================================

BEGIN;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'm'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', r.relname);
  END LOOP;
END $$;

-- employees: drop the column-level grants and restore whole-row access.
REVOKE ALL ON public.employees FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;

COMMIT;
