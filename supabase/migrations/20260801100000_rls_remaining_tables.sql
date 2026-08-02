-- ============================================================================
-- DB-01 — RLS for the tables still reachable by the public anon key
-- ============================================================================
-- Measured with scripts/probe-rls.mjs on 2026-08-01, AFTER
-- 20260801090000_apply_006_rls_idempotent.sql closed the core finance/HR tables.
--
-- Remaining exposure this migration closes (anon could read real rows):
--   company_settings     45 rows  <- contains offer_sheet_secret + bank details
--   provider_connections  1 row   <- plaintext Meta/Google OAuth tokens
--   bank_accounts         3 rows
--   clients              62 rows  <- client PII + public hub/intake tokens
--   discount_logs        60 rows
--   system_jobs         335 rows
--   parameters           59 rows
--   services             41 rows
--   exchange_rates        6 rows
--   tools                 4 rows
-- Plus two that are unprotected but currently empty:
--   quotations, audit_log
--
-- SAFETY — why `TO authenticated` does not break anything:
--   Every public, unauthenticated surface (/intake, /portal, /i, /start,
--   /careers) reads through createAdminClient() — the service role — which
--   bypasses RLS entirely. Verified 2026-08-01. Logged-in browser reads are
--   unaffected because they carry a session.
--
-- SCOPE — this is a floor, not the final model. `USING (true)` for authenticated
--   users closes the anon hole, which is the live exposure. Narrowing reads per
--   designation (so an employee cannot read every salary) is separate work and
--   must not be conflated with this.
--
-- Idempotent. Transactional: applies completely or not at all.
-- Rollback: supabase/rollbacks/20260801100000_rls_remaining_tables_rollback.sql
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'company_settings',
    'provider_connections',
    'bank_accounts',
    'clients',
    'discount_logs',
    'system_jobs',
    'parameters',
    'services',
    'exchange_rates',
    'tools',
    'quotations',
    'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    -- Skip anything that does not exist in this environment.
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'skip % (not present)', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Remove the wide-open baseline policy if it survived.
    EXECUTE format('DROP POLICY IF EXISTS "allow_all" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_authenticated" ON public.%I', t, t);

    EXECUTE format(
      'CREATE POLICY "%s_authenticated" ON public.%I '
      'FOR ALL TO authenticated USING (true) WITH CHECK (true)', t, t);

    -- The anon role must not reach these at all. The service role is unaffected
    -- (it bypasses both grants and RLS), so server-rendered public pages keep working.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);

    RAISE NOTICE 'secured %', t;
  END LOOP;
END $$;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect zero rows:
--   SELECT tablename FROM pg_tables
--   WHERE schemaname='public' AND rowsecurity=false;
-- Then re-run: node scripts/probe-rls.mjs   (should exit 0)
