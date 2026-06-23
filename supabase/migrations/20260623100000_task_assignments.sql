-- task_assignments was referenced by app code in at least two places
-- (the single-task "Assign team" modal in tasks-client.tsx, and the
-- employee dashboard's "my open tasks" query in dashboard/page.tsx) but the
-- table itself was never created — every read silently degraded to [] via
-- the safeQuery missing-table cache, and every write has been failing
-- (PGRST205) since whenever this code shipped. Found while building bulk
-- task-assignment (Batch Actions Everywhere, Phase 2).
--
-- Simple join table: which employees are on a task. Delete-then-insert is
-- the only write pattern used by existing code (no upsert needed).

CREATE TABLE IF NOT EXISTS task_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, employee_id)
);

CREATE INDEX IF NOT EXISTS task_assignments_task_idx ON task_assignments (task_id);
CREATE INDEX IF NOT EXISTS task_assignments_employee_idx ON task_assignments (employee_id);
