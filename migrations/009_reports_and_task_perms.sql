-- ============================================================
-- Migration 009: Reports visibility + granular task action perms
-- ============================================================
-- Adds:
--   reports.view        — access the Reports tab / page
--   tasks.workload      — see the Workload button in Tasks
--   tasks.trash         — see / manage the Trash in Tasks
--
-- These join existing tasks.create, tasks.edit, tasks.delete, tasks.assign
-- which were seeded in 005 but never wired to the UI.
-- After applying, go to Settings → Designations to assign these to roles.
-- ============================================================

-- 1. Add to permissions catalog
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('reports', 'view',
    'reports.view',
    'View Reports',
    'Access the Reports tab — earnings overview, month-wise table, skills analytics',
    90),

  ('tasks', 'workload',
    'tasks.workload',
    'View Workload report',
    'See the Workload button and per-employee task-load breakdown in Tasks',
    19),

  ('tasks', 'trash',
    'tasks.trash',
    'Manage Task Trash',
    'See the Trash button, view soft-deleted tasks, and restore or permanently delete them',
    20)

ON CONFLICT (key) DO NOTHING;

-- 2. Grant all three to every Admin designation automatically
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('reports.view', 'tasks.workload', 'tasks.trash')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- 3. Existing system-preset designations: grant sensible defaults
--    Operations  → tasks.workload (needs to track who is overloaded)
--    Accounts    → reports.view + tasks.workload + tasks.trash
--    Management  → reports.view + tasks.workload
--    Team Lead   → tasks.workload + tasks.trash
-- (all are ON CONFLICT DO NOTHING so re-running is safe)

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.name = 'Operations'
   AND p.key IN ('tasks.workload')
   AND d.is_system = TRUE
ON CONFLICT (designation_id, permission_id) DO NOTHING;

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.name = 'Accounts'
   AND p.key IN ('reports.view', 'tasks.workload', 'tasks.trash')
   AND d.is_system = TRUE
ON CONFLICT (designation_id, permission_id) DO NOTHING;

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.name = 'Management'
   AND p.key IN ('reports.view', 'tasks.workload')
   AND d.is_system = TRUE
ON CONFLICT (designation_id, permission_id) DO NOTHING;

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.name = 'Team Lead'
   AND p.key IN ('tasks.workload', 'tasks.trash')
   AND d.is_system = TRUE
ON CONFLICT (designation_id, permission_id) DO NOTHING;
