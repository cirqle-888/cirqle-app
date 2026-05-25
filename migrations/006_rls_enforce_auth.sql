-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006 — RLS: Replace allow_all with authentication-required policies
-- ─────────────────────────────────────────────────────────────────────────────
--
-- BACKGROUND
-- The initial schema used `USING (true) WITH CHECK (true)` on all tables, which
-- allows any request (including anonymous) to read and write freely, relying
-- entirely on application-layer auth. This migration introduces proper policies:
--
--   • SELECT: any authenticated user can read (app layer controls what's shown)
--   • INSERT / UPDATE / DELETE: only users whose designation grants the required
--     permission key (or whose designation is is_admin=true) can mutate
--
-- The permission checks use helper function `has_permission(auth.uid(), key)`
-- defined below, which joins employees → designations → designation_permissions.
--
-- NOTE: The admin client (service role) bypasses RLS entirely — these policies
--       only apply to the anon/user key used by the browser client. All server
--       actions that use createAdminClient() are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Helper function ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION has_permission(user_auth_id uuid, perm_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM employees e
    JOIN designations d ON d.id = e.designation_id
    WHERE e.auth_id = user_auth_id
      AND e.is_archived = false
      AND (
        d.is_admin = true
        OR EXISTS (
          SELECT 1
          FROM designation_permissions dp
          JOIN permissions p ON p.id = dp.permission_id
          WHERE dp.designation_id = d.id
            AND dp.allowed = true
            AND p.key = perm_key
        )
      )
  )
$$;

-- ─── employees ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON employees;

-- Anyone authenticated can read employee records (name, cqid, etc.)
CREATE POLICY "employees_select_authenticated"
  ON employees FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only users with employees.edit (or admin) may write
CREATE POLICY "employees_insert_perm"
  ON employees FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'employees.create'));

CREATE POLICY "employees_update_perm"
  ON employees FOR UPDATE
  USING (
    -- Users can update their own record (for avatar, emergency contacts etc.)
    auth.uid() = auth_id
    OR has_permission(auth.uid(), 'employees.edit')
  );

-- Archive is a soft-delete — requires employees.archive perm
CREATE POLICY "employees_delete_perm"
  ON employees FOR DELETE
  USING (has_permission(auth.uid(), 'employees.archive'));

-- ─── tasks ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON tasks;

CREATE POLICY "tasks_select_authenticated"
  ON tasks FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "tasks_insert_perm"
  ON tasks FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'tasks.create'));

CREATE POLICY "tasks_update_perm"
  ON tasks FOR UPDATE
  USING (has_permission(auth.uid(), 'tasks.edit'));

CREATE POLICY "tasks_delete_perm"
  ON tasks FOR DELETE
  USING (has_permission(auth.uid(), 'tasks.delete'));

-- ─── contributions ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON contributions;

CREATE POLICY "contributions_select_authenticated"
  ON contributions FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "contributions_insert_perm"
  ON contributions FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'contributions.edit'));

CREATE POLICY "contributions_update_perm"
  ON contributions FOR UPDATE
  USING (has_permission(auth.uid(), 'contributions.edit'));

CREATE POLICY "contributions_delete_perm"
  ON contributions FOR DELETE
  USING (has_permission(auth.uid(), 'contributions.edit'));

-- ─── contribution_scores ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON contribution_scores;

CREATE POLICY "scores_select_authenticated"
  ON contribution_scores FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "scores_insert_perm"
  ON contribution_scores FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'contributions.edit'));

CREATE POLICY "scores_update_perm"
  ON contribution_scores FOR UPDATE
  USING (has_permission(auth.uid(), 'contributions.edit'));

CREATE POLICY "scores_delete_perm"
  ON contribution_scores FOR DELETE
  USING (has_permission(auth.uid(), 'contributions.edit'));

-- ─── payroll ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON payroll;

CREATE POLICY "payroll_select"
  ON payroll FOR SELECT
  USING (
    -- Can read own payroll record or have payroll.view
    EXISTS (
      SELECT 1 FROM employees WHERE auth_id = auth.uid() AND id = payroll.employee_id
    )
    OR has_permission(auth.uid(), 'payroll.view')
  );

CREATE POLICY "payroll_insert_perm"
  ON payroll FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'payroll.edit'));

CREATE POLICY "payroll_update_perm"
  ON payroll FOR UPDATE
  USING (
    has_permission(auth.uid(), 'payroll.edit')
    OR has_permission(auth.uid(), 'payroll.mark_paid')
  );

CREATE POLICY "payroll_delete_perm"
  ON payroll FOR DELETE
  USING (has_permission(auth.uid(), 'payroll.edit'));

-- ─── performance_metrics ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON performance_metrics;

CREATE POLICY "perf_metrics_select"
  ON performance_metrics FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "perf_metrics_write"
  ON performance_metrics FOR ALL
  USING (has_permission(auth.uid(), 'employees.edit'));

-- ─── notifications ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow_all" ON notifications;

-- Users can read their own notifications; admins can read all
CREATE POLICY "notifications_select"
  ON notifications FOR SELECT
  USING (
    auth.uid() IS NOT NULL AND (
      EXISTS (SELECT 1 FROM employees WHERE auth_id = auth.uid() AND id = notifications.employee_id)
      OR has_permission(auth.uid(), 'employees.view')
    )
  );

CREATE POLICY "notifications_insert"
  ON notifications FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "notifications_update"
  ON notifications FOR UPDATE
  USING (
    -- Can mark own notifications read
    EXISTS (SELECT 1 FROM employees WHERE auth_id = auth.uid() AND id = notifications.employee_id)
    OR has_permission(auth.uid(), 'employees.edit')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Additional high-risk tables (not listed in original schema but exist in app)
-- ─────────────────────────────────────────────────────────────────────────────

-- cashbook_entries
ALTER TABLE IF EXISTS cashbook_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON cashbook_entries;

CREATE POLICY "cashbook_select"
  ON cashbook_entries FOR SELECT
  USING (has_permission(auth.uid(), 'cashbook.view'));

CREATE POLICY "cashbook_insert_perm"
  ON cashbook_entries FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'cashbook.edit'));

CREATE POLICY "cashbook_update_perm"
  ON cashbook_entries FOR UPDATE
  USING (has_permission(auth.uid(), 'cashbook.edit'));

CREATE POLICY "cashbook_delete_perm"
  ON cashbook_entries FOR DELETE
  USING (has_permission(auth.uid(), 'cashbook.edit'));

-- salary_advances
ALTER TABLE IF EXISTS salary_advances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON salary_advances;

CREATE POLICY "advances_select"
  ON salary_advances FOR SELECT
  USING (has_permission(auth.uid(), 'payroll.view'));

CREATE POLICY "advances_write"
  ON salary_advances FOR ALL
  USING (has_permission(auth.uid(), 'payroll.edit'));

-- credit_ledger
ALTER TABLE IF EXISTS credit_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON credit_ledger;

CREATE POLICY "credit_select"
  ON credit_ledger FOR SELECT
  USING (has_permission(auth.uid(), 'payroll.view'));

CREATE POLICY "credit_write"
  ON credit_ledger FOR ALL
  USING (has_permission(auth.uid(), 'payroll.edit'));

-- invoices
ALTER TABLE IF EXISTS invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON invoices;

CREATE POLICY "invoices_select"
  ON invoices FOR SELECT
  USING (has_permission(auth.uid(), 'billing.view_invoices'));

CREATE POLICY "invoices_insert"
  ON invoices FOR INSERT
  WITH CHECK (has_permission(auth.uid(), 'billing.edit'));

CREATE POLICY "invoices_update"
  ON invoices FOR UPDATE
  USING (
    has_permission(auth.uid(), 'billing.edit')
    OR has_permission(auth.uid(), 'billing.view_workflow')
  );

CREATE POLICY "invoices_delete"
  ON invoices FOR DELETE
  USING (has_permission(auth.uid(), 'billing.edit'));

-- invoice_items
ALTER TABLE IF EXISTS invoice_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON invoice_items;

CREATE POLICY "invoice_items_select"
  ON invoice_items FOR SELECT
  USING (has_permission(auth.uid(), 'billing.view_invoices'));

CREATE POLICY "invoice_items_write"
  ON invoice_items FOR ALL
  USING (has_permission(auth.uid(), 'billing.edit'));

-- payments
ALTER TABLE IF EXISTS payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON payments;

CREATE POLICY "payments_select"
  ON payments FOR SELECT
  USING (has_permission(auth.uid(), 'billing.view_invoices'));

CREATE POLICY "payments_write"
  ON payments FOR ALL
  USING (has_permission(auth.uid(), 'billing.edit'));

-- designations (read by all, write by settings.manage_designations)
ALTER TABLE IF EXISTS designations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON designations;

CREATE POLICY "designations_select"
  ON designations FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "designations_write"
  ON designations FOR ALL
  USING (has_permission(auth.uid(), 'settings.manage_designations'));

-- designation_permissions
ALTER TABLE IF EXISTS designation_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all" ON designation_permissions;

CREATE POLICY "desig_perms_select"
  ON designation_permissions FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "desig_perms_write"
  ON designation_permissions FOR ALL
  USING (has_permission(auth.uid(), 'settings.manage_designations'));
