-- ============================================================================
-- SEC-03 — Least privilege for logged-in employees
-- ============================================================================
--
-- THE PROBLEM
-- After SEC-02 closes anonymous access, every LOGGED-IN employee still reaches
-- all 174 relations directly through PostgREST, because the RLS floor is
-- `TO authenticated USING (true)` (20260801110000) and `USING (auth.uid() IS
-- NOT NULL)` (migration 006). The app's own authorization — which is good, and
-- which this migration does not change — lives entirely in server actions, and
-- an employee can simply not use the app: the anon key plus their own session
-- is a full read of the database from a browser console.
--
-- Two concrete leaks that motivated this, both verified against live:
--   * employees.base_salary / hourly_rate / bank_details / date_of_birth /
--     invite_token — every colleague's pay and bank details, readable by
--     anyone with a login.
--   * provider_connections, bank_accounts, company_settings (offer_sheet_secret),
--     payslip_emails, ownership_awards, business_partners, audit_log, …
--
-- THE APPROACH — grants, not policy rewrites
-- Every server action and every public page uses createAdminClient() (the
-- service role), which bypasses BOTH grants and RLS. So removing a table from
-- the `authenticated` role cannot break server-rendered pages or actions; it
-- only stops the BROWSER from querying that table directly.
--
-- The retained set below is therefore not a judgement call — it is measured:
--   * every table a 'use client' component queries with the browser client
--     (36 relations), plus
--   * every table subscribed via Realtime postgres_changes (Realtime applies
--     RLS per subscriber, so the role needs SELECT for events to be delivered
--     — this is what makes chat, the notification bell and the live invoice
--     list keep working), plus
--   * conversations / conversation_members, which chat needs alongside the
--     subscribed message tables.
-- Everything else — 133 relations — becomes service-role only.
--
-- Regenerate the list with:  node scripts/rls-keep-list.mjs
--
-- WHAT THIS DOES NOT DO
-- It does not narrow ROW visibility inside the retained tables. An employee who
-- can reach /dashboard/invoices can still read all invoice rows. That needs
-- per-table row policies keyed to the same permission the proxy already checks,
-- and it is staged separately (20260815120000) because it must be verified
-- against the UI before it goes live. This migration is the part that is safe
-- to apply immediately and removes the largest surface.
--
-- Idempotent. Transactional.
-- Rollback: supabase/rollbacks/20260815110000_authenticated_least_privilege_down.sql
-- ============================================================================

BEGIN;

-- ── PART A: only the browser-reachable relations keep an authenticated grant ─
DO $$
DECLARE
  r record;
  keep text[] := ARRAY[
    'ad_projects',
    'bank_accounts',
    'cashbook_audit_log',
    'cashbook_categories',
    'cashbook_entries',
    'cashbook_invoice_allocations',
    'cashbook_payroll_allocations',
    'client_branding',
    'client_service_pricing',
    'clients',
    'company_settings',
    'contribution_groups',
    'contribution_scores',
    'contributions',
    'conversation_members',
    'conversations',
    'designation_permissions',
    'designations',
    'discount_logs',
    'employee_performance_history',
    'employee_service_categories',
    'employee_services',
    'employees',
    'exchange_rates',
    'group_services',
    'invoice_change_logs',
    'invoice_expense_items',
    'invoice_items',
    'invoices',
    'message_plays',
    'message_reads',
    'messages',
    'notifications',
    'parameters',
    'payments',
    'payroll',
    'permissions',
    'product_catalog',
    'quotation_items',
    'quotations',
    'service_categories',
    'services',
    'social_calendar_items',
    'social_calendars',
    'task_assignments',
    'task_group_assignments',
    'task_groups',
    'task_parameter_assignments',
    'task_requests',
    'task_tools',
    'tasks',
    'tool_services',
    'tools'
  ];
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
  LOOP
    IF NOT (r.relname = ANY(keep)) THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', r.relname);
    END IF;
  END LOOP;
END $$;

-- ── PART B: employees — column-level grants ─────────────────────────────────
-- RLS is row-level and cannot hide a COLUMN, so pay and bank details are
-- withheld with column privileges instead. Verified against every browser
-- query and PostgREST embed of this table: role-context.tsx selects
-- (id, auth_id, name, email, role, cqid, is_active, avatar_url),
-- settings-client.tsx selects (cqid), and every embed is (id, name, cqid).
-- Filtering also needs the privilege, which is why auth_id and email are here.
--
-- NOT granted, and therefore service-role only: base_salary, hourly_rate,
-- salary_type, reveal_salary, bank_details, date_of_birth, phone,
-- emergency_contact_name, emergency_contact_phone, invite_token,
-- invite_token_expires_at, registered_at, joined_date, performance_rating.
REVOKE ALL ON public.employees FROM authenticated;
GRANT SELECT (
  id, auth_id, cqid, name, email, avatar_url, role,
  is_active, is_archived, designation_id, current_workspace_id
) ON public.employees TO authenticated;

-- Employees still edit their own avatar/workspace from the browser.
GRANT UPDATE (avatar_url, current_workspace_id) ON public.employees TO authenticated;

-- Future tables must not silently hand authenticated a blanket grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;

COMMIT;
