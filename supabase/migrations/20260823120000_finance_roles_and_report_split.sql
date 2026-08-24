-- ============================================================================
-- Finance roles + the reports.view three-way split
-- ============================================================================
-- Additive, idempotent, NON-DESTRUCTIVE. Pure INSERT/UPDATE — no drops, no
-- deletes. Safe to run in the Supabase SQL editor, and safe to re-run.
--
-- WHY
-- All eleven report pages sat behind ONE key, `reports.view`. Granting a
-- bookkeeper the client profitability report therefore also handed them
-- Cirqle's own P&L, burn rate, runway, bank balance, every employee's earnings
-- and the commission what-if planner. There was no way to express "this person
-- may see client money but not company money or salaries".
--
-- Split three ways:
--   reports.view_company_financials  Cirqle's own P&L, burn/runway, dept P&L,
--                                    cost attribution, business health
--   reports.view_client_financials   client profitability, department growth,
--                                    billing reconciliation, client ranking
--   reports.view_people_earnings     earnings by role, contribution analysis,
--                                    the commission what-if planner
--
-- BACKWARD COMPATIBLE. Every page still accepts the old `reports.view`, and
-- part 2 grants all three new keys to anyone who already holds it, so nobody
-- loses access the moment this runs. The split only bites once `reports.view`
-- is removed from a designation — which is the deliberate act of narrowing it.
-- ============================================================================

BEGIN;

-- ── 1. The three new permissions ────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES
  ('reports', 'view_company_financials', 'reports.view_company_financials',
   'View company financials',
   'Cirqle''s own P&L, burn rate, runway, bank balance, department P&L and cost attribution.', 21),
  ('reports', 'view_client_financials', 'reports.view_client_financials',
   'View client financials',
   'Client profitability and margin, department growth, billing reconciliation and client ranking.', 22),
  ('reports', 'view_people_earnings', 'reports.view_people_earnings',
   'View people earnings',
   'Earnings by role, contribution analysis and the commission what-if planner — every employee''s pay-affecting figures.', 23)
ON CONFLICT (key) DO NOTHING;

-- ── 2. Backfill: nobody loses access on deploy ──────────────────────────────
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, np.id, true
  FROM public.designation_permissions dp
  JOIN public.permissions old ON old.id = dp.permission_id AND old.key = 'reports.view'
  CROSS JOIN public.permissions np
 WHERE dp.allowed = true
   AND np.key IN ('reports.view_company_financials',
                  'reports.view_client_financials',
                  'reports.view_people_earnings')
ON CONFLICT (designation_id, permission_id) DO NOTHING;

-- ── 3. The finance designations ─────────────────────────────────────────────
-- is_system = false on purpose: these are STARTING POINTS. Every one stays
-- fully editable and deletable in Settings → Access & Roles, so the page-level
-- and field-level toggles can be tuned per person without touching SQL.
-- Guarded with NOT EXISTS rather than ON CONFLICT (name): there is no proven
-- unique index on designations.name in this database, and a missing constraint
-- would make ON CONFLICT error out rather than no-op.
INSERT INTO public.designations (name, description, is_admin, is_system, display_order)
SELECT v.name, v.description, v.is_admin, v.is_system, v.display_order
  FROM (VALUES
  ('Finance Controller',
   'Senior finance. Full finance management incl. edit and approval: invoices, cashbook, statements, partners, packages, payments, plus company and client financial reports. Payroll and salary figures are NOT included — grant payroll.* separately if this person should see them.',
   false, false, 30),
  ('Accountant',
   'Day-to-day accounting: invoices, cashbook, statements, partners and packages with amounts, plus client financial reports. No company P&L or burn/runway, no salaries.',
   false, false, 31),
  ('Accountant Assistant',
   'Data entry. Creates and edits invoices and cashbook entries and sees invoice amounts, but not company financials, not other people''s earnings and not salaries.',
   false, false, 32),
  ('Finance Executive',
   'Read-only finance: invoices, statements, partners and client financial reports with amounts. Cannot edit anything.',
   false, false, 33),
  ('Auditor',
   'Read-only across ALL finance, including company P&L, burn/runway and payroll amounts. Cannot edit, approve or mark anything paid.',
   false, false, 34)
  ) AS v(name, description, is_admin, is_system, display_order)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.designations d WHERE d.name = v.name
 );

-- ── 4. Grants, per role ─────────────────────────────────────────────────────
-- Written as (role, key) pairs so the intent is readable and re-running is a
-- no-op. A key that does not exist in this database is simply skipped by the
-- join, so a partially-migrated schema cannot fail this migration.
WITH wanted(role_name, perm_key) AS (
  VALUES
    -- ── Finance Controller ──────────────────────────────────────────────
    -- Deliberately NO payroll.* — salary is separately permissioned, as asked.
    -- Deliberately NO settings.access — finance is not system administration.
    ('Finance Controller', 'dashboard.view'),
    ('Finance Controller', 'dashboard.view_analytics'),
    ('Finance Controller', 'billing.view_invoices'),
    ('Finance Controller', 'billing.view_quotations'),
    ('Finance Controller', 'billing.view_workflow'),
    ('Finance Controller', 'billing.view_amounts'),
    ('Finance Controller', 'billing.view_line_pricing'),
    ('Finance Controller', 'billing.view_pricing'),
    ('Finance Controller', 'billing.edit'),
    ('Finance Controller', 'cashbook.view'),
    ('Finance Controller', 'cashbook.view_amounts'),
    ('Finance Controller', 'cashbook.edit'),
    ('Finance Controller', 'finance.partner.view'),
    ('Finance Controller', 'finance.partner.create'),
    ('Finance Controller', 'finance.partner.edit'),
    ('Finance Controller', 'finance.partner.export'),
    ('Finance Controller', 'packages.view'),
    ('Finance Controller', 'tasks.view_all'),
    ('Finance Controller', 'tasks.view_own'),
    ('Finance Controller', 'tasks.view_pricing'),
    ('Finance Controller', 'tasks.export'),
    ('Finance Controller', 'clients.view'),
    ('Finance Controller', 'reports.view_company_financials'),
    ('Finance Controller', 'reports.view_client_financials'),

    -- ── Accountant ──────────────────────────────────────────────────────
    ('Accountant', 'dashboard.view'),
    ('Accountant', 'billing.view_invoices'),
    ('Accountant', 'billing.view_quotations'),
    ('Accountant', 'billing.view_workflow'),
    ('Accountant', 'billing.view_amounts'),
    ('Accountant', 'billing.view_line_pricing'),
    ('Accountant', 'billing.view_pricing'),
    ('Accountant', 'billing.edit'),
    ('Accountant', 'cashbook.view'),
    ('Accountant', 'cashbook.view_amounts'),
    ('Accountant', 'cashbook.edit'),
    ('Accountant', 'finance.partner.view'),
    ('Accountant', 'finance.partner.export'),
    ('Accountant', 'packages.view'),
    ('Accountant', 'tasks.view_all'),
    ('Accountant', 'tasks.view_own'),
    ('Accountant', 'tasks.view_pricing'),
    ('Accountant', 'clients.view'),
    ('Accountant', 'reports.view_client_financials'),

    -- ── Accountant Assistant ────────────────────────────────────────────
    -- Enters the books; cannot see what the company itself is worth, what
    -- anyone earns, or what anyone is paid.
    ('Accountant Assistant', 'dashboard.view'),
    ('Accountant Assistant', 'billing.view_invoices'),
    ('Accountant Assistant', 'billing.view_workflow'),
    ('Accountant Assistant', 'billing.view_amounts'),
    ('Accountant Assistant', 'billing.edit'),
    ('Accountant Assistant', 'cashbook.view'),
    ('Accountant Assistant', 'cashbook.view_amounts'),
    ('Accountant Assistant', 'cashbook.edit'),
    ('Accountant Assistant', 'tasks.view_all'),
    ('Accountant Assistant', 'tasks.view_own'),
    ('Accountant Assistant', 'clients.view'),

    -- ── Finance Executive (read-only) ───────────────────────────────────
    ('Finance Executive', 'dashboard.view'),
    ('Finance Executive', 'billing.view_invoices'),
    ('Finance Executive', 'billing.view_quotations'),
    ('Finance Executive', 'billing.view_workflow'),
    ('Finance Executive', 'billing.view_amounts'),
    ('Finance Executive', 'billing.view_line_pricing'),
    ('Finance Executive', 'cashbook.view'),
    ('Finance Executive', 'cashbook.view_amounts'),
    ('Finance Executive', 'finance.partner.view'),
    ('Finance Executive', 'packages.view'),
    ('Finance Executive', 'tasks.view_all'),
    ('Finance Executive', 'tasks.view_own'),
    ('Finance Executive', 'tasks.view_pricing'),
    ('Finance Executive', 'clients.view'),
    ('Finance Executive', 'reports.view_client_financials'),

    -- ── Auditor (read-only, sees everything money) ──────────────────────
    ('Auditor', 'dashboard.view'),
    ('Auditor', 'dashboard.view_analytics'),
    ('Auditor', 'billing.view_invoices'),
    ('Auditor', 'billing.view_quotations'),
    ('Auditor', 'billing.view_workflow'),
    ('Auditor', 'billing.view_amounts'),
    ('Auditor', 'billing.view_line_pricing'),
    ('Auditor', 'billing.view_pricing'),
    ('Auditor', 'cashbook.view'),
    ('Auditor', 'cashbook.view_amounts'),
    ('Auditor', 'finance.partner.view'),
    ('Auditor', 'finance.partner.export'),
    ('Auditor', 'packages.view'),
    ('Auditor', 'payroll.view'),
    ('Auditor', 'payroll.view_amounts'),
    ('Auditor', 'employees.view'),
    ('Auditor', 'tasks.view_all'),
    ('Auditor', 'tasks.view_own'),
    ('Auditor', 'tasks.view_pricing'),
    ('Auditor', 'tasks.export'),
    ('Auditor', 'clients.view'),
    ('Auditor', 'contributions.view_all'),
    ('Auditor', 'contributions.view_earnings'),
    ('Auditor', 'reports.view_company_financials'),
    ('Auditor', 'reports.view_client_financials'),
    ('Auditor', 'reports.view_people_earnings')
)
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, true
  FROM wanted w
  JOIN public.designations d ON d.name = w.role_name
  JOIN public.permissions  p ON p.key  = w.perm_key
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = true;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SELECT d.name, count(*) FILTER (WHERE dp.allowed) AS perms
--   FROM public.designations d
--   LEFT JOIN public.designation_permissions dp ON dp.designation_id = d.id
--  WHERE d.name IN ('Finance Controller','Accountant','Accountant Assistant',
--                   'Finance Executive','Auditor')
--  GROUP BY d.name ORDER BY d.name;
