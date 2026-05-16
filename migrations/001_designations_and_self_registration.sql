-- ============================================================
-- CIRQLE: Designations, Permissions, Self-Registration, Archive
-- Migration 001 — safe to run on existing live database.
-- Run this in Supabase SQL editor.
-- ============================================================

-- ============================================================
-- 1. DESIGNATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS designations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  is_admin BOOLEAN DEFAULT FALSE,
  is_system BOOLEAN DEFAULT FALSE,
  display_order INT DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. PERMISSIONS CATALOG
-- ============================================================
CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  display_order INT DEFAULT 100
);

-- ============================================================
-- 3. DESIGNATION ↔ PERMISSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS designation_permissions (
  designation_id UUID REFERENCES designations(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (designation_id, permission_id)
);

-- ============================================================
-- 4. EMPLOYEES: NEW COLUMNS
-- ============================================================
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS invite_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS designation_id UUID REFERENCES designations(id),
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;

-- ============================================================
-- 5. CQID AUTO-GENERATION
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS cqid_seq START 1;

-- Backfill: bump sequence past the highest existing CQID number.
DO $$
DECLARE max_cqid INT;
BEGIN
  SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(cqid, '\D', '', 'g'), '')::int), 0)
    INTO max_cqid FROM employees;
  IF max_cqid > 0 THEN
    PERFORM setval('cqid_seq', max_cqid);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION next_cqid() RETURNS TEXT AS $$
  SELECT 'CQID' || LPAD(nextval('cqid_seq')::text, 3, '0')
$$ LANGUAGE SQL;

ALTER TABLE employees ALTER COLUMN cqid SET DEFAULT next_cqid();

-- ============================================================
-- 6. PROFILE CHANGE REQUESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS profile_change_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  changes JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES employees(id),
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_change_requests_status
  ON profile_change_requests(status, submitted_at DESC);

-- ============================================================
-- 7. SEED PERMISSIONS CATALOG
-- ============================================================
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('dashboard', 'view',     'dashboard.view',          'View dashboard',          'See the dashboard home page', 10),
  ('dashboard', 'view_analytics', 'dashboard.view_analytics', 'View analytics',   'See dashboard analytics widgets', 11),

  ('tasks', 'view_own',     'tasks.view_own',          'View own tasks',          'See tasks where you are an assignee', 20),
  ('tasks', 'view_all',     'tasks.view_all',          'View all tasks',          'See every task in the org', 21),
  ('tasks', 'create',       'tasks.create',            'Create tasks',            'Create new tasks', 22),
  ('tasks', 'edit',         'tasks.edit',              'Edit tasks',              'Edit task details', 23),
  ('tasks', 'delete',       'tasks.delete',            'Delete tasks',            'Delete tasks', 24),
  ('tasks', 'assign',       'tasks.assign',            'Assign tasks',            'Assign tasks to employees', 25),
  ('tasks', 'export',       'tasks.export',            'Export tasks',            'Export tasks list as CSV', 26),

  ('contributions', 'view_own', 'contributions.view_own', 'View own contributions', 'See your own contribution rows', 30),
  ('contributions', 'view_all', 'contributions.view_all', 'View all contributions', 'See everyone''s contributions', 31),
  ('contributions', 'edit',     'contributions.edit',     'Edit contributions',     'Score / edit contributions', 32),

  ('employees', 'view',         'employees.view',          'View employees',         'See the employees list', 40),
  ('employees', 'view_full',    'employees.view_full',     'View full employee names', 'See real names instead of CQID', 41),
  ('employees', 'create',       'employees.create',        'Create employees',       'Add new employees', 42),
  ('employees', 'edit',         'employees.edit',          'Edit employees',         'Edit any employee details', 43),
  ('employees', 'archive',      'employees.archive',       'Archive employees',      'Archive / restore employees', 44),
  ('employees', 'review_change_requests', 'employees.review_change_requests', 'Review change requests', 'Approve / reject profile change requests', 45),
  ('employees', 'reveal_names', 'employees.reveal_names',  'Reveal names toggle',    'Use the temporary "Reveal names" toggle', 46),

  ('payroll', 'view',       'payroll.view',            'View payroll',            'See payroll data', 50),
  ('payroll', 'edit',       'payroll.edit',            'Edit payroll',            'Edit payroll entries', 51),

  ('billing', 'view_invoices',   'billing.view_invoices',   'View invoices',     'See invoices', 60),
  ('billing', 'view_quotations', 'billing.view_quotations', 'View quotations',   'See quotations', 61),
  ('billing', 'edit',            'billing.edit',            'Edit billing',      'Create / edit invoices, quotations, pricing', 62),
  ('billing', 'view_pricing',    'billing.view_pricing',    'View pricing',      'See billing_amount, commission % on tasks', 63),

  ('cashbook', 'view',      'cashbook.view',           'View cash book',          'See cash book entries', 70),
  ('cashbook', 'edit',      'cashbook.edit',           'Edit cash book',          'Add / edit cash book entries', 71),

  ('settings', 'access',                'settings.access',                'Access settings',     'Open the settings area', 80),
  ('settings', 'manage_designations',   'settings.manage_designations',   'Manage designations', 'Create / edit designations + permissions', 81),
  ('settings', 'manage_company',        'settings.manage_company',        'Manage company',      'Edit company settings, branding', 82)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 8. SEED DEFAULT DESIGNATIONS
-- ============================================================
INSERT INTO designations (name, description, is_admin, is_system, display_order) VALUES
  ('Admin',    'Full access to everything', TRUE, TRUE, 1),
  ('Employee', 'Default designation for new staff — sees own data only', FALSE, TRUE, 100)
ON CONFLICT (name) DO NOTHING;

-- Admin gets every permission
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'Admin'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Employee gets only dashboard.view + *.view_own
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'Employee'
    AND p.key IN ('dashboard.view', 'tasks.view_own', 'contributions.view_own')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- ============================================================
-- 9. MIGRATE EXISTING EMPLOYEES → ASSIGN DESIGNATIONS
-- ============================================================
DO $$
DECLARE admin_id UUID; emp_id UUID;
BEGIN
  SELECT id INTO admin_id FROM designations WHERE name = 'Admin';
  SELECT id INTO emp_id   FROM designations WHERE name = 'Employee';

  UPDATE employees SET designation_id = admin_id
    WHERE designation_id IS NULL AND role = 'super_admin';
  UPDATE employees SET designation_id = emp_id
    WHERE designation_id IS NULL;
END $$;

-- ============================================================
-- 10. RLS HELPER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION current_employee_designation_has(perm_key TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM employees e
    JOIN designations d ON d.id = e.designation_id
    WHERE e.auth_id = auth.uid()
      AND e.is_archived = FALSE
      AND d.is_admin = TRUE
  )
  OR EXISTS (
    SELECT 1 FROM employees e
    JOIN designation_permissions dp ON dp.designation_id = e.designation_id
    JOIN permissions p ON p.id = dp.permission_id
    WHERE e.auth_id = auth.uid()
      AND e.is_archived = FALSE
      AND p.key = perm_key
      AND dp.allowed = TRUE
  )
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_employee_id() RETURNS UUID AS $$
  SELECT id FROM employees WHERE auth_id = auth.uid() AND is_archived = FALSE LIMIT 1
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ============================================================
-- 11. ENABLE RLS ON SENSITIVE TABLES
-- ============================================================
ALTER TABLE employees                ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE contributions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE contribution_scores      ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_service_pricing   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE designations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE designation_permissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_change_requests  ENABLE ROW LEVEL SECURITY;

-- Reset any old policies (idempotent re-run)
DROP POLICY IF EXISTS employees_select ON employees;
DROP POLICY IF EXISTS employees_update ON employees;
DROP POLICY IF EXISTS tasks_select     ON tasks;
DROP POLICY IF EXISTS tasks_modify     ON tasks;
DROP POLICY IF EXISTS contributions_select ON contributions;
DROP POLICY IF EXISTS contributions_modify ON contributions;
DROP POLICY IF EXISTS contribution_scores_select ON contribution_scores;
DROP POLICY IF EXISTS client_service_pricing_all ON client_service_pricing;
DROP POLICY IF EXISTS invoices_all      ON invoices;
DROP POLICY IF EXISTS payments_all      ON payments;
DROP POLICY IF EXISTS payroll_all       ON payroll;
DROP POLICY IF EXISTS cashbook_all      ON cashbook_entries;
DROP POLICY IF EXISTS designations_select ON designations;
DROP POLICY IF EXISTS designations_modify ON designations;
DROP POLICY IF EXISTS permissions_select ON permissions;
DROP POLICY IF EXISTS designation_permissions_select ON designation_permissions;
DROP POLICY IF EXISTS designation_permissions_modify ON designation_permissions;
DROP POLICY IF EXISTS pcr_select ON profile_change_requests;
DROP POLICY IF EXISTS pcr_insert ON profile_change_requests;
DROP POLICY IF EXISTS pcr_update ON profile_change_requests;

-- Employees: every logged-in user can SELECT (so CQID/designation joins work),
-- but client code hides sensitive fields. UPDATE restricted to admins.
CREATE POLICY employees_select ON employees FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY employees_update ON employees FOR UPDATE USING (
  current_employee_designation_has('employees.edit')
);

-- Tasks
CREATE POLICY tasks_select ON tasks FOR SELECT USING (
  current_employee_designation_has('tasks.view_all')
  OR (
    current_employee_designation_has('tasks.view_own')
    AND id IN (
      SELECT task_id FROM contributions WHERE employee_id = current_employee_id()
    )
  )
);
CREATE POLICY tasks_modify ON tasks FOR ALL USING (
  current_employee_designation_has('tasks.create')
  OR current_employee_designation_has('tasks.edit')
);

-- Contributions
CREATE POLICY contributions_select ON contributions FOR SELECT USING (
  current_employee_designation_has('contributions.view_all')
  OR (
    current_employee_designation_has('contributions.view_own')
    AND employee_id = current_employee_id()
  )
);
CREATE POLICY contributions_modify ON contributions FOR ALL USING (
  current_employee_designation_has('contributions.edit')
);

-- Contribution scores (per-task derived totals) — same as contributions
CREATE POLICY contribution_scores_select ON contribution_scores FOR SELECT USING (
  current_employee_designation_has('contributions.view_all')
  OR (
    current_employee_designation_has('contributions.view_own')
    AND employee_id = current_employee_id()
  )
);

-- Finance tables — admin only
CREATE POLICY client_service_pricing_all ON client_service_pricing FOR ALL USING (
  current_employee_designation_has('billing.view_pricing')
  OR current_employee_designation_has('billing.edit')
);
CREATE POLICY invoices_all ON invoices FOR ALL USING (
  current_employee_designation_has('billing.view_invoices')
);
CREATE POLICY payments_all ON payments FOR ALL USING (
  current_employee_designation_has('billing.view_invoices')
);
CREATE POLICY payroll_all ON payroll FOR ALL USING (
  current_employee_designation_has('payroll.view')
);
CREATE POLICY cashbook_all ON cashbook_entries FOR ALL USING (
  current_employee_designation_has('cashbook.view')
);

-- Designations / permissions — readable by all logged-in (needed for client perm-context),
-- writable only by admins
CREATE POLICY designations_select ON designations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY designations_modify ON designations FOR ALL USING (
  current_employee_designation_has('settings.manage_designations')
);
CREATE POLICY permissions_select ON permissions FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY designation_permissions_select ON designation_permissions FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY designation_permissions_modify ON designation_permissions FOR ALL USING (
  current_employee_designation_has('settings.manage_designations')
);

-- Profile change requests
CREATE POLICY pcr_select ON profile_change_requests FOR SELECT USING (
  employee_id = current_employee_id()
  OR current_employee_designation_has('employees.review_change_requests')
);
CREATE POLICY pcr_insert ON profile_change_requests FOR INSERT WITH CHECK (
  employee_id = current_employee_id()
);
CREATE POLICY pcr_update ON profile_change_requests FOR UPDATE USING (
  current_employee_designation_has('employees.review_change_requests')
);

-- ============================================================
-- 12. DONE
-- ============================================================
-- After running this migration:
--  • Existing employees are mapped: super_admin → Admin designation, others → Employee.
--  • The Admin designation has every permission; Employee has only view_own.
--  • RLS is now enforced on tasks, contributions, billing, payroll, cashbook.
--  • CQID auto-generates on new employee insert.
--  • Self-registration via invite_token is ready.
