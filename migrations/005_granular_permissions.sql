-- ============================================================
-- CIRQLE: Granular financial visibility + role presets
-- Migration 005 — safe to run on existing live database.
-- Run this in Supabase SQL editor.
--
-- Adds:
--   1. New permission keys that separate WORKFLOW access (open page, mark
--      paid/sent/reviewed, add entries) from FINANCIAL visibility (see ₹
--      totals, amounts, prices, earnings).
--   2. Five role-preset designations (Operations, Accounts, HR, Reviewer,
--      Management) that bundle common perm sets.
--
-- Defaults: all new *.view_amounts / view_earnings / view_pricing perms are
-- DENIED for every existing non-admin designation. Admin keeps full access via
-- the existing "Admin gets everything" seed.
-- ============================================================

-- ============================================================
-- 1. NEW PERMISSION KEYS
-- ============================================================
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  -- Tasks: a user with tasks.view_pricing can see billing_amount/loss_amount
  -- on task cards/tables. Without it, those fields never reach their browser.
  ('tasks', 'view_pricing',
    'tasks.view_pricing',
    'View task pricing',
    'See billing amounts, currency, loss amounts, and billing-mode details on task cards/table',
    27),

  -- Contributions: separate "see scores/percentages" from "see ₹ earnings".
  ('contributions', 'view_earnings',
    'contributions.view_earnings',
    'View contribution earnings',
    'See ₹ earned per contribution row in addition to score percentage',
    33),

  -- Payroll: separate "open payroll module" from "see salary amounts".
  -- A reviewer can verify the payroll status flow without seeing salary figures.
  ('payroll', 'view_amounts',
    'payroll.view_amounts',
    'View payroll amounts',
    'See ₹ base salary, commission, advances, deductions, and net salary figures',
    52),

  -- Billing: split into workflow + amounts + per-line pricing.
  --   view_workflow → can open invoice page, change status (paid/sent/review)
  --   view_amounts  → can see totals, paid totals, outstanding amounts
  --   view_line_pricing → can see per-item / per-task pricing breakdown
  ('billing', 'view_workflow',
    'billing.view_workflow',
    'Manage invoice workflow',
    'Open invoices and change status (sent / paid / reviewed) without necessarily seeing amounts',
    64),
  ('billing', 'view_amounts',
    'billing.view_amounts',
    'View invoice amounts',
    'See ₹ totals, paid totals, outstanding, and payment amounts on invoices',
    65),
  ('billing', 'view_line_pricing',
    'billing.view_line_pricing',
    'View invoice line pricing',
    'See per-item / per-task pricing on invoice detail',
    66),

  -- Cashbook: separate "open module + edit entries" from "see ₹ amounts".
  ('cashbook', 'view_amounts',
    'cashbook.view_amounts',
    'View cash book amounts',
    'See ₹ inflow/outflow values and bank balance figures',
    72)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 2. ENSURE ADMIN AUTO-GRANTS THE NEW PERMS
-- ============================================================
-- The original seed grants admin every existing perm at install time; after
-- adding new permission rows we re-run the same insert so admins inherit them.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.is_admin = TRUE
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- ============================================================
-- 3. EXPLICITLY DENY NEW FINANCIAL PERMS FOR EXISTING NON-ADMIN DESIGNATIONS
-- ============================================================
-- The permission system treats "missing row" as denied, so this step is
-- belt-and-suspenders — it makes the OFF state visible in the designations UI
-- so admins can see exactly what's gated and choose to enable per-designation.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, FALSE
  FROM designations d, permissions p
  WHERE d.is_admin = FALSE
    AND p.key IN (
      'tasks.view_pricing',
      'contributions.view_earnings',
      'payroll.view_amounts',
      'billing.view_workflow',
      'billing.view_amounts',
      'billing.view_line_pricing',
      'cashbook.view_amounts'
    )
ON CONFLICT (designation_id, permission_id) DO NOTHING;

-- ============================================================
-- 4. ROLE PRESET DESIGNATIONS
-- ============================================================
-- All marked is_system so they survive upgrades and can be re-applied
-- predictably. Display order spaces them between Admin (1) and Employee (100).
INSERT INTO designations (name, description, is_admin, is_system, display_order) VALUES
  ('Operations', 'Day-to-day task ops: full task + contribution access, no financial visibility',                 FALSE, TRUE, 20),
  ('Accounts',   'Finance team: full billing/cashbook/payroll visibility including all ₹ amounts',                 FALSE, TRUE, 30),
  ('HR',         'People ops: employees + payroll workflow without salary amount visibility',                       FALSE, TRUE, 40),
  ('Reviewer',   'Read-only auditor: can view everything (including amounts) but cannot edit',                      FALSE, TRUE, 50),
  ('Management', 'Senior staff: visibility into all modules and amounts, no settings/designation management',       FALSE, TRUE, 60)
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 5. SEED PRESET PERMISSION SETS
-- ============================================================
-- Each block grants exactly the perms that match the preset's intent.
-- Anything not granted defaults to denied.

-- 5a. Operations: tasks/contributions full access (incl. workflow + creation),
--     dashboard.view; NO financial visibility (no view_pricing/view_earnings/
--     view_amounts/view_line_pricing).
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'Operations'
    AND p.key IN (
      'dashboard.view',
      'tasks.view_own', 'tasks.view_all', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.export',
      'contributions.view_own', 'contributions.view_all', 'contributions.edit',
      'employees.view'
    )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- 5b. Accounts: full financial visibility. Can manage invoices, cashbook,
--     payroll. Sees all ₹ amounts including pricing details.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'Accounts'
    AND p.key IN (
      'dashboard.view', 'dashboard.view_analytics',
      'tasks.view_own', 'tasks.view_all', 'tasks.view_pricing',
      'contributions.view_own', 'contributions.view_all', 'contributions.view_earnings',
      'employees.view',
      'payroll.view', 'payroll.view_amounts', 'payroll.edit',
      'billing.view_invoices', 'billing.view_quotations', 'billing.edit', 'billing.view_pricing',
      'billing.view_workflow', 'billing.view_amounts', 'billing.view_line_pricing',
      'cashbook.view', 'cashbook.edit', 'cashbook.view_amounts'
    )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- 5c. HR: people + payroll workflow without salary amounts. Can mark payroll
--     statuses but salary figures are masked. Full employee management.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'HR'
    AND p.key IN (
      'dashboard.view',
      'employees.view', 'employees.view_full', 'employees.create', 'employees.edit', 'employees.archive',
      'employees.review_change_requests', 'employees.reveal_names',
      'payroll.view'
      -- Note: no payroll.view_amounts → HR can verify payroll status flow but
      -- the ₹ figures are masked.
    )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- 5d. Reviewer: read-only across everything. Includes view_amounts on each
--     module but no .edit perms anywhere.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'Reviewer'
    AND p.key IN (
      'dashboard.view', 'dashboard.view_analytics',
      'tasks.view_own', 'tasks.view_all', 'tasks.view_pricing', 'tasks.export',
      'contributions.view_own', 'contributions.view_all', 'contributions.view_earnings',
      'employees.view', 'employees.view_full',
      'payroll.view', 'payroll.view_amounts',
      'billing.view_invoices', 'billing.view_quotations', 'billing.view_pricing',
      'billing.view_workflow', 'billing.view_amounts', 'billing.view_line_pricing',
      'cashbook.view', 'cashbook.view_amounts'
    )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- 5e. Management: senior staff sees all modules + all amounts, but cannot
--     touch settings/designations.
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
  WHERE d.name = 'Management'
    AND p.key IN (
      'dashboard.view', 'dashboard.view_analytics',
      'tasks.view_own', 'tasks.view_all', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.export', 'tasks.view_pricing',
      'contributions.view_own', 'contributions.view_all', 'contributions.edit', 'contributions.view_earnings',
      'employees.view', 'employees.view_full', 'employees.edit',
      'payroll.view', 'payroll.view_amounts',
      'billing.view_invoices', 'billing.view_quotations', 'billing.edit', 'billing.view_pricing',
      'billing.view_workflow', 'billing.view_amounts', 'billing.view_line_pricing',
      'cashbook.view', 'cashbook.edit', 'cashbook.view_amounts'
    )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
