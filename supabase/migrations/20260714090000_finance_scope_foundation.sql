-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Finance Foundation — Phase 1: explicit Scope + Statement Sections        ║
-- ║                                                                            ║
-- ║  Replaces the implicit "internal = client_id IS NULL" convention with a   ║
-- ║  first-class financial dimension:                                          ║
-- ║                                                                            ║
-- ║    scope             'client'  — flows through to a client's economics    ║
-- ║                      'company' — Cirqle's own operations                   ║
-- ║                      (cashbook only: NULL = not yet triaged)               ║
-- ║                                                                            ║
-- ║    statement_section (on categories) — where a movement lands on a P&L:   ║
-- ║                      revenue | cogs | opex | financial | excluded         ║
-- ║    account_code      dot-hierarchy report line, e.g. 'opex.salaries'      ║
-- ║                      (data, not code — new P&L lines are category rows,   ║
-- ║                       and the string hierarchy is forward-compatible      ║
-- ║                       with a future chart-of-accounts table)              ║
-- ║    default_scope     what a new entry in this category usually is         ║
-- ║                                                                            ║
-- ║  Compatibility shim: BEFORE INSERT/UPDATE triggers derive scope whenever  ║
-- ║  a write does not provide one, so every pre-Phase-2 code path keeps       ║
-- ║  working unchanged. Backfill only auto-classifies unambiguous rows;       ║
-- ║  ambiguous cashbook rows stay NULL for the Phase-3 triage queue —         ║
-- ║  we never guess about money.                                              ║
-- ║                                                                            ║
-- ║  Zero behavior change for existing code. Idempotent. Rollback:            ║
-- ║  supabase/rollbacks/20260714090000_finance_scope_foundation_down.sql      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ── 1. Scope columns ─────────────────────────────────────────────────────────

ALTER TABLE public.tasks            ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE public.ad_projects      ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE public.cashbook_entries ADD COLUMN IF NOT EXISTS scope TEXT;

-- ── 2. Category classification columns ──────────────────────────────────────

ALTER TABLE public.cashbook_categories
  ADD COLUMN IF NOT EXISTS statement_section TEXT,
  ADD COLUMN IF NOT EXISTS account_code      TEXT,
  ADD COLUMN IF NOT EXISTS default_scope     TEXT;

-- ── 3. Seed the classification for the stock categories ─────────────────────
-- Keyed on name and only where still NULL: idempotent, and never clobbers a
-- mapping the user has since edited. Categories that match nothing simply stay
-- NULL and appear as "Unclassified" in reports (surfaced by the verify script).

WITH mapping (name, section, account, dscope) AS (
  VALUES
    -- inflows
    ('Invoice',                   'revenue',   'revenue.services',            'client'),
    ('Visiting Charge',           'revenue',   'revenue.visiting_charges',    'client'),
    ('Commission',                'revenue',   'revenue.commission',          'client'),
    ('Cost Recovery',             'revenue',   'revenue.cost_recovery',       'client'),
    ('Credit Return',             'financial', 'financial.credit_return',     'company'),
    ('Other Income',              'revenue',   'revenue.other',               NULL),
    -- outflows
    ('Salary',                    'opex',      'opex.salaries',               'company'),
    ('Rent & Workspace',          'opex',      'opex.rent',                   'company'),
    ('Communication & Utilities', 'opex',      'opex.utilities',              'company'),
    ('Online Spend',              'cogs',      'cogs.ad_spend',               'client'),
    ('Software & Subscriptions',  'opex',      'opex.software',               'company'),
    ('Printing & Stationery',     'opex',      'opex.office_supplies',        NULL),
    ('Equipment & Devices',       'opex',      'opex.equipment',              'company'),
    ('Office & Furniture',        'opex',      'opex.office',                 'company'),
    ('Business Purchases',        'cogs',      'cogs.purchases',              NULL),
    ('Travel & Commute',          'opex',      'opex.travel',                 NULL),
    ('Food & Entertainment',      'opex',      'opex.entertainment',          'company'),
    ('Bank Fees & Surcharges',    'opex',      'opex.bank_fees',              'company'),
    ('Personal Withdrawals',      'excluded',  'excluded.owner_drawings',     'company'),
    ('Tax & Government Fees',     'opex',      'opex.taxes_fees',             'company'),
    ('Professional Services',     'opex',      'opex.professional_services',  'company'),
    ('Credit Given',              'financial', 'financial.credit_given',      'company'),
    ('Marketing & Promotions',    'opex',      'opex.marketing',              'company')
)
UPDATE public.cashbook_categories c
   SET statement_section = COALESCE(c.statement_section, m.section),
       account_code      = COALESCE(c.account_code,      m.account),
       default_scope     = COALESCE(c.default_scope,     m.dscope)
  FROM mapping m
 WHERE c.name = m.name;

-- ── 4. Backfill scope (unambiguous rows only) ───────────────────────────────

UPDATE public.tasks
   SET scope = CASE WHEN client_id IS NULL THEN 'company' ELSE 'client' END
 WHERE scope IS NULL;

UPDATE public.ad_projects
   SET scope = CASE WHEN client_id IS NULL THEN 'company' ELSE 'client' END
 WHERE scope IS NULL;

UPDATE public.cashbook_entries e
   SET scope = CASE
     WHEN e.client_id   IS NOT NULL THEN 'client'
     WHEN e.employee_id IS NOT NULL THEN 'company'   -- salaries, advances
     WHEN e.transfer_ref IS NOT NULL THEN 'company'  -- internal account transfers
     WHEN e.reference LIKE 'payroll:%' THEN 'company'
     ELSE (SELECT c.default_scope FROM public.cashbook_categories c
            WHERE c.id = e.category_id AND c.default_scope = 'company')
   END                                               -- everything else: NULL → triage
 WHERE e.scope IS NULL;

-- ── 5. Compatibility shim: derive scope when a write doesn't provide it ─────
-- Old code never sends scope; these triggers keep every legacy write path
-- consistent so the CHECK constraints below can be enforced immediately.

CREATE OR REPLACE FUNCTION public.derive_task_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope IS NULL THEN
    NEW.scope := CASE WHEN NEW.client_id IS NULL THEN 'company' ELSE 'client' END;
  ELSIF NEW.scope = 'client' AND NEW.client_id IS NULL THEN
    -- legacy edit paths can clear the client (task made internal) without
    -- knowing about scope; follow the client_id, which is what they mean
    NEW.scope := 'company';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_derive_task_scope ON public.tasks;
CREATE TRIGGER trg_derive_task_scope
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.derive_task_scope();

DROP TRIGGER IF EXISTS trg_derive_ad_project_scope ON public.ad_projects;
CREATE TRIGGER trg_derive_ad_project_scope
  BEFORE INSERT OR UPDATE ON public.ad_projects
  FOR EACH ROW EXECUTE FUNCTION public.derive_task_scope();  -- same shape: client_id + scope

CREATE OR REPLACE FUNCTION public.derive_cashbook_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope IS NULL THEN
    NEW.scope := CASE
      WHEN NEW.client_id   IS NOT NULL THEN 'client'
      WHEN NEW.employee_id IS NOT NULL THEN 'company'
      WHEN NEW.transfer_ref IS NOT NULL THEN 'company'
      WHEN NEW.reference LIKE 'payroll:%' THEN 'company'
      ELSE (SELECT c.default_scope FROM public.cashbook_categories c
             WHERE c.id = NEW.category_id AND c.default_scope = 'company')
    END;                                            -- ambiguous → NULL (triage)
  ELSIF NEW.scope = 'client' AND NEW.client_id IS NULL THEN
    NEW.scope := NULL;                              -- can't be client money without a client
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_derive_cashbook_scope ON public.cashbook_entries;
CREATE TRIGGER trg_derive_cashbook_scope
  BEFORE INSERT OR UPDATE ON public.cashbook_entries
  FOR EACH ROW EXECUTE FUNCTION public.derive_cashbook_scope();

-- ── 6. Enforce NOT NULL where the backfill is total ──────────────────────────

ALTER TABLE public.tasks       ALTER COLUMN scope SET NOT NULL;
ALTER TABLE public.ad_projects ALTER COLUMN scope SET NOT NULL;
-- cashbook_entries.scope stays nullable: NULL is the explicit "untriaged" state.

-- ── 7. Integrity constraints ─────────────────────────────────────────────────
-- Plain (validating) constraints are safe here: the backfill above makes every
-- existing row consistent by construction, and the triggers keep new rows so.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_scope_valid') THEN
    ALTER TABLE public.tasks ADD CONSTRAINT tasks_scope_valid
      CHECK (scope IN ('client','company'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_scope_client_integrity') THEN
    ALTER TABLE public.tasks ADD CONSTRAINT tasks_scope_client_integrity
      CHECK (scope = 'company' OR client_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_projects_scope_valid') THEN
    ALTER TABLE public.ad_projects ADD CONSTRAINT ad_projects_scope_valid
      CHECK (scope IN ('client','company'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_projects_scope_client_integrity') THEN
    ALTER TABLE public.ad_projects ADD CONSTRAINT ad_projects_scope_client_integrity
      CHECK (scope = 'company' OR client_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashbook_entries_scope_valid') THEN
    ALTER TABLE public.cashbook_entries ADD CONSTRAINT cashbook_entries_scope_valid
      CHECK (scope IS NULL OR scope IN ('client','company'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashbook_entries_scope_client_integrity') THEN
    ALTER TABLE public.cashbook_entries ADD CONSTRAINT cashbook_entries_scope_client_integrity
      CHECK (scope IS DISTINCT FROM 'client' OR client_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashbook_categories_section_valid') THEN
    ALTER TABLE public.cashbook_categories ADD CONSTRAINT cashbook_categories_section_valid
      CHECK (statement_section IS NULL
             OR statement_section IN ('revenue','cogs','opex','financial','excluded'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashbook_categories_default_scope_valid') THEN
    ALTER TABLE public.cashbook_categories ADD CONSTRAINT cashbook_categories_default_scope_valid
      CHECK (default_scope IS NULL OR default_scope IN ('client','company'));
  END IF;
END $$;

-- ── 8. Indexes for the finance read paths ────────────────────────────────────

CREATE INDEX IF NOT EXISTS cashbook_entries_scope_idx
  ON public.cashbook_entries (scope, entry_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cashbook_entries_scope_triage_idx
  ON public.cashbook_entries (entry_date) WHERE deleted_at IS NULL AND scope IS NULL;
CREATE INDEX IF NOT EXISTS tasks_scope_idx
  ON public.tasks (scope, task_date) WHERE deleted_at IS NULL;

COMMIT;
