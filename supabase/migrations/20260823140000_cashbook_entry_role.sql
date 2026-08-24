-- ============================================================================
-- "Cashbook Entry" — a data-entry role that sees no money it does not type
-- ============================================================================
-- Additive, idempotent, NON-DESTRUCTIVE. INSERT only. Safe to re-run.
--
-- The ask: an employee who can ADD cashbook entries, but must not see cashbook
-- totals, must not see task prices, and must not see anything payroll.
--
--   cashbook.view   + cashbook.edit   and NOT cashbook.view_amounts
--     -> opens the page, the Add Entry form works (its own Amount field is
--        theirs to type), but the Inflow/Outflow/Balance summary cards are not
--        rendered and every existing entry's amount is stripped SERVER-SIDE,
--        so the figures never reach the browser at all.
--
--   tasks.view_all  and NOT tasks.view_pricing
--     -> tasks are visible; billing_amount, billing_amount_inr, currency,
--        billing_mode/percent/override and is_billable are stripped from the
--        payload by stripTaskPricing.
--
--   no payroll.* at all
--     -> HR & Payroll and Months disappear from the nav, middleware refuses
--        /dashboard/payroll, and the Cash Book page no longer fetches pending
--        payslips or the employee credit ledger (both are gated on
--        payroll.view_amounts as of this change).
--
-- Deliberately absent: billing.* (invoice totals), contributions.view_earnings,
-- reports.*, packages.view, settings.access.
-- ============================================================================

BEGIN;

INSERT INTO public.designations (name, description, is_admin, is_system, display_order)
SELECT v.name, v.description, v.is_admin, v.is_system, v.display_order
  FROM (VALUES
    ('Cashbook Entry',
     'Adds cash book entries only. Cannot see cash book totals or existing entry amounts, cannot see task prices, and has no payroll access of any kind.',
     false, false, 35)
  ) AS v(name, description, is_admin, is_system, display_order)
 WHERE NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.name = v.name);

WITH wanted(role_name, perm_key) AS (
  VALUES
    ('Cashbook Entry', 'dashboard.view'),
    ('Cashbook Entry', 'cashbook.view'),
    ('Cashbook Entry', 'cashbook.edit'),
    ('Cashbook Entry', 'tasks.view_own'),
    ('Cashbook Entry', 'tasks.view_all'),
    ('Cashbook Entry', 'clients.view')
    -- NOT cashbook.view_amounts  — no totals, no existing amounts
    -- NOT tasks.view_pricing     — no task prices
    -- NOT payroll.*              — no salary data anywhere
    -- NOT billing.*              — no invoice totals
    -- NOT contributions.view_earnings
)
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, true
  FROM wanted w
  JOIN public.designations d ON d.name = w.role_name
  JOIN public.permissions  p ON p.key  = w.perm_key
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = true;

COMMIT;
