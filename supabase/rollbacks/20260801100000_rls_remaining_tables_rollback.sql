-- ============================================================================
-- ROLLBACK for 20260801100000_rls_remaining_tables.sql
-- ============================================================================
-- Reverts the 12 tables to their pre-migration state: RLS off, policy dropped,
-- anon grants restored.
--
-- WARNING: running this re-opens company_settings (offer_sheet_secret, bank
-- details), provider_connections (plaintext OAuth tokens), bank_accounts and
-- clients to the public anon key. Only use it if the migration demonstrably
-- broke a production flow, and re-apply as soon as that flow is fixed.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'company_settings', 'provider_connections', 'bank_accounts', 'clients',
    'discount_logs', 'system_jobs', 'parameters', 'services',
    'exchange_rates', 'tools', 'quotations', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN CONTINUE; END IF;

    EXECUTE format('DROP POLICY IF EXISTS "%s_authenticated" ON public.%I', t, t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon', t);
  END LOOP;
END $$;

COMMIT;
