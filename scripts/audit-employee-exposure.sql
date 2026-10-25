-- ============================================================================
-- EMPLOYEE DATA-EXPOSURE CHECK — 100% READ-ONLY. Paste into the Supabase SQL
-- editor (project lgqarkdmlyfpacyqhfha) and run. Nothing is written and no row
-- data from any app table is selected.
--
-- Confirms the 2026-10-24 access audit against the LIVE database: for each
-- confidential table, can a signed-in employee (role `authenticated`) read it
-- directly, and what does the row policy say? The audit read these from the
-- migration files; this shows whether anything was changed by hand since.
-- ============================================================================

-- ── 1. Grants and RLS state on the tables the audit flagged ─────────────────
SELECT
  c.relname                                               AS relation,
  c.relrowsecurity                                        AS rls_enabled,
  has_table_privilege('authenticated', c.oid, 'SELECT')   AS employee_can_select,
  has_table_privilege('authenticated', c.oid, 'UPDATE')   AS employee_can_update,
  has_table_privilege('authenticated', c.oid, 'INSERT')   AS employee_can_insert,
  has_table_privilege('authenticated', c.oid, 'DELETE')   AS employee_can_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'contribution_scores', 'contributions', 'tasks', 'cashbook_payroll_allocations',
    'invoice_change_logs', 'quotation_items', 'quotations', 'clients',
    'client_service_pricing', 'discount_logs', 'employee_performance_history',
    'payroll', 'cashbook_entries', 'invoices', 'invoice_items', 'payments', 'employees'
  )
ORDER BY c.relname;

-- ── 2. The live row policies on those tables ────────────────────────────────
-- A SELECT/ALL policy whose using_expression is `true` or
-- `(auth.uid() IS NOT NULL)` lets EVERY signed-in employee read every row.
SELECT tablename, policyname, cmd, roles, qual AS using_expression, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'contribution_scores', 'contributions', 'tasks', 'cashbook_payroll_allocations',
    'invoice_change_logs', 'quotation_items', 'quotations', 'clients',
    'client_service_pricing', 'discount_logs', 'employee_performance_history',
    'payroll', 'cashbook_entries', 'invoices', 'invoice_items', 'payments', 'employees'
  )
ORDER BY tablename, cmd, policyname;

-- ── 3. Column-level grants that would narrow a table (only employees has them today)
SELECT table_name, column_name
FROM information_schema.column_privileges
WHERE grantee = 'authenticated' AND privilege_type = 'SELECT' AND table_schema = 'public'
  AND table_name IN ('contribution_scores', 'tasks', 'clients', 'quotation_items', 'employees')
ORDER BY table_name, column_name;
