-- ============================================================================
-- "Task Manager + Collections" — one designation, three jobs
-- ============================================================================
-- Additive, idempotent, NON-DESTRUCTIVE. INSERT only. Safe to re-run.
--
-- An employee holds exactly ONE designation: employees.designation_id is a
-- single FK and there is no join table. Two roles cannot be assigned, so the
-- combined role IS the mechanism — this is the union of Task Manager and
-- Cashbook Entry, plus invoice collections.
--
-- WHAT IT ADDS OVER Task Manager
--   cashbook.view + cashbook.edit ....... adds cash book entries. NOT
--     cashbook.view_amounts, so the Inflow/Outflow/Balance cards do not render
--     and existing entry amounts are stripped server-side.
--   clients.view ........................ the entry form's client picker.
--   billing.view_invoices ............... opens Invoices and Follow-ups. These
--     share one middleware gate (/^\/dashboard\/invoices/), so Follow-ups
--     cannot be granted without the Invoices list.
--   billing.view_amounts ................ invoice totals and outstanding, so a
--     collections call can quote what is owed.
--   billing.view_workflow ............... logs follow-ups and marks drafts
--     sent. The narrow write key: follow-ups/actions.ts accepts
--     billing.edit OR billing.view_workflow on all four write paths.
--
-- DELIBERATELY ABSENT
--   billing.edit ............ cannot create, delete or re-price invoices
--   billing.view_pricing .... legacy key that exposes task billing amounts
--   tasks.view_pricing ...... task prices stay hidden
--   cashbook.view_amounts ... no cash book totals
--   payroll.* ............... no salary data anywhere
--   billing.view_line_pricing, packages.view, reports.*, settings.*
-- ============================================================================

BEGIN;

INSERT INTO public.designations (name, description, is_admin, is_system, display_order)
SELECT v.name, v.description, v.is_admin, v.is_system, v.display_order
  FROM (VALUES
    ('Task Manager + Collections',
     'Task Manager, plus cash book entry (no totals) and invoice follow-ups with amounts. Can log follow-ups and mark drafts sent, but cannot edit invoices, see task prices, cash book totals or any payroll data.',
     false, false, 36)
  ) AS v(name, description, is_admin, is_system, display_order)
 WHERE NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.name = v.name);

WITH wanted(role_name, perm_key) AS (
  VALUES
    -- ── from Task Manager ───────────────────────────────────────────────
    ('Task Manager + Collections', 'dashboard.view'),
    ('Task Manager + Collections', 'tasks.view_own'),
    ('Task Manager + Collections', 'tasks.view_all'),
    ('Task Manager + Collections', 'tasks.create'),
    ('Task Manager + Collections', 'tasks.edit'),
    ('Task Manager + Collections', 'tasks.assign'),
    ('Task Manager + Collections', 'tasks.delete'),
    ('Task Manager + Collections', 'tasks.trash'),
    ('Task Manager + Collections', 'contributions.edit'),
    ('Task Manager + Collections', 'contributions.view_all'),
    ('Task Manager + Collections', 'contributions.view_unit'),
    ('Task Manager + Collections', 'chat.access'),
    ('Task Manager + Collections', 'chat.create_channels'),
    ('Task Manager + Collections', 'chat.client_conversations'),
    -- ── from Cashbook Entry ─────────────────────────────────────────────
    ('Task Manager + Collections', 'cashbook.view'),
    ('Task Manager + Collections', 'cashbook.edit'),
    ('Task Manager + Collections', 'clients.view'),
    -- ── invoice collections ─────────────────────────────────────────────
    ('Task Manager + Collections', 'billing.view_invoices'),
    ('Task Manager + Collections', 'billing.view_amounts'),
    ('Task Manager + Collections', 'billing.view_workflow')
)
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, true
  FROM wanted w
  JOIN public.designations d ON d.name = w.role_name
  JOIN public.permissions  p ON p.key  = w.perm_key
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = true;

COMMIT;
