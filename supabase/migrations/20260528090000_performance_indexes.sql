-- ============================================================
-- Performance: hot-path indexes
-- Date: 2026-05-28
--
-- Postgres does NOT auto-create indexes for FOREIGN KEY columns. As a result,
-- every PostgREST embedded join (invoices → invoice_items → tasks/services,
-- invoices → payments, tasks → clients/services) and every `task_date` /
-- `calculated_at` filter + ORDER BY was doing a SEQUENTIAL SCAN. On the
-- invoices page this is the cause of the ~7.5s cold load; it also slows the
-- dashboard, reports, payroll, tasks, and contributions pages.
--
-- This migration adds B-tree indexes on the columns actually used in JOIN /
-- WHERE / ORDER BY by those pages. Every statement is idempotent
-- (IF NOT EXISTS) and NON-BREAKING — indexes only change performance, never
-- query results.
--
-- Safe to run on a live DB. CREATE INDEX briefly blocks writes (not reads) on
-- each table; for these table sizes that is sub-second. If any table is very
-- large you may instead run that single statement as
-- `CREATE INDEX CONCURRENTLY ...` by hand (CONCURRENTLY cannot run inside the
-- transactional migration below).
-- ============================================================

-- ── Invoices page: nested invoice_items + payments joins (the 7.5s hotspot) ──
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_task_id    ON invoice_items (task_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_service_id ON invoice_items (service_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id      ON payments (invoice_id);

-- ── Tasks: task_date is filtered (.gte/.eq) AND ordered on nearly every
--    analytics query; client/service are embedded joins on most pages. ──
CREATE INDEX IF NOT EXISTS idx_tasks_task_date  ON tasks (task_date);
CREATE INDEX IF NOT EXISTS idx_tasks_client_id  ON tasks (client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_service_id ON tasks (service_id);

-- ── Contribution scores: calculated_at is filtered (.gte) + ordered on the
--    dashboard / payroll / reports pages; employee_id scopes employee views.
--    (task_id is already covered by the UNIQUE(task_id, employee_id) index.) ──
CREATE INDEX IF NOT EXISTS idx_contribution_scores_calculated_at ON contribution_scores (calculated_at);
CREATE INDEX IF NOT EXISTS idx_contribution_scores_employee_id   ON contribution_scores (employee_id);

-- ── Contributions: employee_id scopes reports/skills + "My Tasks".
--    (task_id is covered by the UNIQUE(task_id, employee_id, parameter_id) index.) ──
CREATE INDEX IF NOT EXISTS idx_contributions_employee_id ON contributions (employee_id);

-- ── Payroll family: employee_id joins/scoping. payroll.employee_id is already
--    covered by UNIQUE(employee_id, month, year), so it is omitted here. ──
CREATE INDEX IF NOT EXISTS idx_salary_advances_employee_id ON salary_advances (employee_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_entity_id     ON credit_ledger (entity_id);
CREATE INDEX IF NOT EXISTS idx_deductions_employee_id      ON deductions (employee_id);
CREATE INDEX IF NOT EXISTS idx_deductions_invoice_id       ON deductions (invoice_id);

-- ── Cash book: entry_date is ordered on every fetch; category_id is filtered. ──
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_entry_date  ON cashbook_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_category_id ON cashbook_entries (category_id);

-- ── Columns/tables added by later migrations — guarded so this file never
--    aborts on an install that hasn't applied them yet. ──
DO $$
BEGIN
  -- tasks.deleted_at — soft-delete trash list + 45-day purge filter.
  -- Partial index stays tiny (only the handful of soft-deleted rows) and
  -- speeds the trash query (.not deleted_at is null) and the purge sweep.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'deleted_at'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at
      ON tasks (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;

  -- "My Tasks" employee filter — employee-scoped lookups across the
  -- assignment graph (each table is created by a feature migration).
  IF to_regclass('public.task_assignments') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_task_assignments_employee_id
      ON task_assignments (employee_id);
  END IF;
  IF to_regclass('public.task_group_assignments') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_task_group_assignments_employee_id
      ON task_group_assignments (employee_id);
  END IF;
  IF to_regclass('public.task_parameter_assignments') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_task_parameter_assignments_employee_id
      ON task_parameter_assignments (employee_id);
  END IF;
END $$;

-- Refresh planner statistics so the new indexes are chosen immediately
-- instead of waiting for the next autovacuum cycle.
ANALYZE invoice_items, payments, tasks, contribution_scores, contributions,
        salary_advances, credit_ledger, deductions, cashbook_entries;
