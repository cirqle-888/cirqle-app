-- ============================================================================
-- cashbook.view_totals + tasks.view_totals — split "one row's amount" from
-- "the aggregate across many rows", the way billing.view_totals already
-- splits from billing.view_amounts.
--
-- WHY: the Task Manager designation holds cashbook.view_amounts and
-- tasks.view_pricing (so it can see what one entry / one task costs — needed
-- for its job), but that same grant was also the only thing standing between
-- it and the Cash Book's Inflow/Outflow/Net/FX summary, the Accounts tab's
-- bank balances, and Tasks' per-day totals — none of which the role needs to
-- do collections or task admin, and all of which are company financial
-- position, not one transaction's figure.
--
-- This migration adds the two new permission rows and, for every designation
-- EXCEPT Task Manager, grants the new "totals" permission wherever that
-- designation already holds the matching "amounts" permission — so nothing
-- changes for anyone else. Task Manager gets an explicit FALSE row instead of
-- a merely-absent one, so Access & Roles shows the gate as visibly off.
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING / DO UPDATE, safe to
-- re-run.
-- ============================================================================

INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('cashbook', 'view_totals',
    'cashbook.view_totals',
    'View cash book totals',
    'See the Inflow/Outflow/Net/FX summary cards and the Accounts tab''s balances — the company''s cash position, aggregated across entries. Separate from "View cash book amounts", which covers one entry''s own figure.',
    73),
  ('tasks', 'view_totals',
    'tasks.view_totals',
    'View task group totals',
    'See the summed ₹ total for a group of tasks (e.g. a day''s worth in the table view). Separate from "View task pricing", which covers one task''s own billing amount.',
    28)
ON CONFLICT (key) DO NOTHING;

-- Admins inherit every permission, same as every prior permission migration.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.is_admin = TRUE
    AND p.key IN ('cashbook.view_totals', 'tasks.view_totals')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Preserve today's behaviour everywhere except Task Manager: whoever already
-- sees cashbook amounts keeps seeing cashbook totals too.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, p2.id, TRUE
  FROM designation_permissions dp
  JOIN permissions p1  ON p1.id = dp.permission_id AND p1.key = 'cashbook.view_amounts'
  JOIN permissions p2  ON p2.key = 'cashbook.view_totals'
  JOIN designations d  ON d.id = dp.designation_id AND d.is_admin = FALSE AND d.name <> 'Task Manager'
 WHERE dp.allowed = TRUE
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Same, for tasks: whoever already sees task pricing keeps seeing task totals.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, p2.id, TRUE
  FROM designation_permissions dp
  JOIN permissions p1  ON p1.id = dp.permission_id AND p1.key = 'tasks.view_pricing'
  JOIN permissions p2  ON p2.key = 'tasks.view_totals'
  JOIN designations d  ON d.id = dp.designation_id AND d.is_admin = FALSE AND d.name <> 'Task Manager'
 WHERE dp.allowed = TRUE
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Task Manager: explicit FALSE, not merely absent, so the toggle in Access &
-- Roles reads as a deliberate "off" rather than an unreviewed gap.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, FALSE
  FROM designations d, permissions p
  WHERE d.name = 'Task Manager' AND d.is_admin = FALSE
    AND p.key IN ('cashbook.view_totals', 'tasks.view_totals')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = FALSE;
