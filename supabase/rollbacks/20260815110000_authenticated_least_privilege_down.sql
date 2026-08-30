-- Rollback for 20260815110000_authenticated_least_privilege (Part A).
--
-- Re-grants `authenticated` on every table outside the keep list, undoing the
-- broad revoke. This REOPENS the exposure the migration closed — every logged-in
-- employee can read those tables from the browser again — so it is for unbreaking
-- production, not for routine use.
--
-- ── FIDELITY ────────────────────────────────────────────────────────────────
-- Measured immediately before the revoke on 2026-08-30, `authenticated` held one
-- of three privilege signatures across the 161 tables it could reach:
--
--   DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE   139 tables
--   REFERENCES,SELECT,TRIGGER,TRUNCATE                         21 tables
--   INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE                    1 table
--
-- This file grants ALL to every revoked table, so it restores function exactly
-- but slightly OVER-grants on the 22 that had no UPDATE/DELETE. That is the
-- right trade for an emergency restore — RLS policies still apply on top, and
-- re-applying the migration re-tightens everything. If you need byte-exact
-- restoration instead, re-derive it per table from a point-in-time backup.
--
-- The `employees` column grants are NOT part of this file: they were split into
-- 20260830120000 and have never been applied.

BEGIN;

DO $$
DECLARE
  r record;
  keep text[] := ARRAY[
    'ad_projects','cashbook_audit_log','cashbook_entries','cashbook_invoice_allocations',
    'cashbook_payroll_allocations','client_branding','client_service_pricing','clients',
    'contribution_groups','contribution_scores','contributions','conversation_members',
    'conversations','designation_permissions','designations','discount_logs',
    'employee_performance_history','employees','exchange_rates','group_services',
    'invoice_change_logs','invoice_expense_items','invoice_items','invoices',
    'message_plays','message_reads','messages','notifications','parameters','payments',
    'payroll','permissions','product_catalog','quotation_items','quotations','services',
    'social_calendar_items','social_calendars','task_assignments','task_group_assignments',
    'task_groups','task_parameter_assignments','task_requests','task_tools','tasks',
    'tool_services','tools'
  ];
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
  LOOP
    IF NOT (r.relname = ANY(keep)) THEN
      EXECUTE format('GRANT ALL ON public.%I TO authenticated', r.relname);
    END IF;
  END LOOP;
END $$;

-- The migration also stopped new tables inheriting a blanket grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;

COMMIT;
