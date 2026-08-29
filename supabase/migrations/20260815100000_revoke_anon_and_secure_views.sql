-- ============================================================================
-- SEC-02 — CRITICAL: close the unauthenticated read of company financials
-- ============================================================================
--
-- THE BREACH (measured 2026-08-15, against the live database)
-- 22 relations were readable by the PUBLIC anon key with NO login at all. The
-- anon key is not a secret — it is compiled into the client bundle and served
-- to every visitor, so "anyone who opened the site" is the actual audience:
--
--   invoice_summary              58 rows  client_name, total_billed,
--                                         total_received, total_outstanding
--                                         -> every client's identity and full
--                                            billing position
--   monthly_cashbook_summary     37 rows  year, month, inflow, outflow, net
--                                         -> the company's cash flow
--   mv_campaign_performance                spend, revenue, profit, margin, roas
--   mv_client_performance                  per-client profit and margin
--   mv_agency_benchmarks                   agency-wide margins
--   business_partners             4 rows  partner name, phone, email and
--                                         commission terms (PII + contracts)
--   allocation_audit_log       1321 rows  financial allocation history
--   cashbook_invoice_allocations 427 rows
--   cashbook_payroll_allocations  62 rows  payroll amounts
--   cashbook_entry_employee_splits         per-employee money
--   ad_wallet_ledger, ad_accounts, ad_businesses, ad_sync_logs,
--   employee_favorites, task_tools, group_services, cashbook_categories,
--   cashbook_tags, cashbook_entry_tags, contribution_groups, workspaces
--
-- WHY THE EARLIER RLS WORK MISSED IT
-- 20260801110000_rls_all_tables.sql loops over
--     SELECT tablename FROM pg_tables WHERE rowsecurity = false
-- which misses this exact set two ways:
--   1. VIEWS and MATERIALIZED VIEWS are not in pg_tables at all, so
--      invoice_summary, monthly_cashbook_summary and every mv_* were never
--      touched. A view also runs with its OWNER's rights unless it is
--      declared security_invoker, so it bypasses the underlying tables' RLS
--      even when those tables are correctly locked down.
--   2. `rowsecurity = false` skips a table that already had RLS ENABLED but
--      carried a permissive allow-all policy — the migration only repaired
--      tables with RLS switched off.
--
-- The companion probe (scripts/probe-rls.mjs) reported "0 exposed" because its
-- table list is hand-maintained and contains no views. scripts/sweep-anon.mjs
-- (added alongside this migration) enumerates every relation PostgREST exposes
-- instead, so this class of hole cannot hide again.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
--
-- STEP 1 revokes ALL privileges on every table, view and materialized view in
-- `public` from `anon`. Verified safe by reading every public surface:
--   * /portal /intake /i /start /feed read through createAdminClient()
--     (service role) — RLS and grants do not apply to them.
--   * /careers touches only Storage (signed-URL upload), not PostgREST.
--   * /login /forgot-password /reset-password use GoTrue auth only.
--   * The one browser-side anon table read that did exist (DynamicFavicon
--     reading company_settings) was removed in this same audit; it now goes
--     through /api/favicon on the service role.
--   Storage and auth grants are separate and are NOT affected by this.
--
-- STEP 2 additionally removes `authenticated` from the RLS-BYPASSING relations
-- that no browser code reads. These are the ones that leak company-wide
-- finances to any logged-in employee regardless of table RLS:
--   invoice_summary, monthly_cashbook_summary, allocation_audit_log
--       -> zero references anywhere in src/ (legacy views)
--   mv_campaign_performance, mv_client_performance, mv_agency_benchmarks
--       -> read only by src/lib/advertising/ai/benchmarks.ts, which uses
--          createAdminClient() (service role)
--
-- Deliberately NOT touched: cashbook_invoice_allocations,
-- cashbook_payroll_allocations, business_partners and the rest keep their
-- `authenticated` grant, because real client components read them with the
-- browser session (e.g. invoices-client.tsx, allocation-modal.tsx). Narrowing
-- those needs per-table row policies and is tracked separately — this
-- migration is scoped to the unauthenticated breach, which is the live one.
--
-- Idempotent. Transactional: applies completely or not at all.
-- Rollback: supabase/rollbacks/20260815100000_revoke_anon_and_secure_views_down.sql
-- ============================================================================

BEGIN;

-- ── STEP 1: no anonymous reads of anything in public ────────────────────────
-- Covers tables, views and foreign tables.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- Materialized views are relkind 'm' and are NOT included in
-- "ALL TABLES IN SCHEMA", so they need an explicit pass.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'm'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.relname);
  END LOOP;
END $$;

-- Stop the next `CREATE TABLE` from silently handing anon a grant again.
-- NOTE: default privileges are per-granting-role. This covers objects created
-- by the role that runs this migration; a table created by a different role
-- (e.g. through the dashboard as supabase_admin) can still pick up the stock
-- grant. That is why sweep-anon.mjs exists — run it after adding tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- ── STEP 2: RLS-bypassing relations no browser code reads ───────────────────
DO $$
DECLARE
  r record;
  targets text[] := ARRAY[
    'invoice_summary',
    'monthly_cashbook_summary',
    'allocation_audit_log',
    'mv_campaign_performance',
    'mv_client_performance',
    'mv_agency_benchmarks'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
      RAISE NOTICE 'revoked authenticated on %', t;
    ELSE
      RAISE NOTICE 'skipped % (not present)', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
