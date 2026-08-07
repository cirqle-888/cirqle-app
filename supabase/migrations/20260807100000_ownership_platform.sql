-- ═══════════════════════════════════════════════════════════════════════════
-- OWNERSHIP PLATFORM + ORGANIZATION MODEL — v1.0 of the permanent architecture
--
-- Two layers, both designed so that GROWING the business is data entry, not
-- schema change:
--
--   1. ORGANIZATION — one typed, self-nesting `org_units` table covering
--      departments, teams, branches, regions and client groups. Adding a new
--      kind of unit ("Division") is a CHECK value, not a sixth table; adding a
--      new branch is an INSERT. Membership carries `is_manager`, so multiple
--      managers per unit are free forever — the cardinality mistake that
--      normally forces a migration is designed out from the start.
--
--   2. OWNERSHIP — Programs (what/when/from what) × Rules (who/how much)
--      → Awards (immutable computed snapshots) → payroll. Revenue share,
--      profit share, monthly/quarterly/yearly incentives, festival and
--      performance bonuses are all CONFIGURATIONS of this one engine, never
--      separate systems. `program_type` is a display label only; behaviour
--      comes entirely from basis + period_type + scope.
--
-- THE CONTRIBUTION ENGINE IS UNTOUCHED. Nothing here reads or writes
-- contribution_scores, the pool, ratings or tool deductions. Ownership is a
-- SECOND, independent earning stream:
--     final earnings = contribution earnings + ownership rewards
--                      + prior-period adjustments + optional fixed salary
--
-- STRICTLY ADDITIVE: six new tables + one nullable-by-default column on
-- payroll. Every reader is written defensively, so an environment without this
-- migration behaves exactly as it does today, and an employee with no rules
-- has byte-identical payroll.
--
-- Rollback: supabase/rollbacks/20260807100000_ownership_platform_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Organization units ──────────────────────────────────────────────────
-- ONE table, not one per kind. `type` is data, `parent_id` gives hierarchy
-- (region → branch → team), and both are why adding an organizational concept
-- later never touches this schema again.
--
-- 'client_group' is included deliberately: a named set of clients is
-- structurally the same thing as a unit whose scope lists those clients, and
-- modelling it here means it gets an account manager for free (via members)
-- the day that is wanted.
CREATE TABLE IF NOT EXISTS public.org_units (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  type          text NOT NULL DEFAULT 'team'
                  CHECK (type IN ('department','team','branch','region','client_group')),
  parent_id     uuid REFERENCES public.org_units(id) ON DELETE SET NULL,
  is_active     boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  notes         text,
  created_by    uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)      -- no self-parenting
);
CREATE INDEX IF NOT EXISTS org_units_type_idx   ON public.org_units (type, is_active);
CREATE INDEX IF NOT EXISTS org_units_parent_idx ON public.org_units (parent_id);

COMMENT ON TABLE public.org_units IS
  'Departments, teams, branches, regions and client groups in one typed, self-nesting table. Adding a kind of unit is a CHECK value; adding a unit is an INSERT.';

-- Membership. `is_manager` on the JOIN (not a manager_id on the unit) is what
-- makes "multiple managers", "multiple HR", "multiple coordinators" native
-- rather than a future migration.
CREATE TABLE IF NOT EXISTS public.org_unit_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES public.org_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  is_manager  boolean NOT NULL DEFAULT false,
  /** Free-text responsibility shown on the employee profile: 'Team Lead', 'HR'. */
  role_label  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, employee_id)
);
CREATE INDEX IF NOT EXISTS org_unit_members_emp_idx ON public.org_unit_members (employee_id);

COMMENT ON COLUMN public.org_unit_members.is_manager IS
  'Multiple managers per unit are supported by design — nothing anywhere assumes one.';

-- What revenue a unit "owns". This mapping is what makes a rule like
-- "5% of Branch Kochi billing" computable: the branch resolves to a set of
-- clients / service categories / services, and billing is summed over them.
-- All three columns nullable; a row scopes by whichever it sets.
CREATE TABLE IF NOT EXISTS public.org_unit_scopes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id             uuid NOT NULL REFERENCES public.org_units(id) ON DELETE CASCADE,
  client_id           uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  service_category_id uuid REFERENCES public.service_categories(id) ON DELETE CASCADE,
  service_id          uuid REFERENCES public.services(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Exactly one dimension per row keeps resolution unambiguous.
  CHECK (
    (CASE WHEN client_id           IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN service_category_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN service_id          IS NULL THEN 0 ELSE 1 END) = 1
  )
);
CREATE INDEX IF NOT EXISTS org_unit_scopes_unit_idx ON public.org_unit_scopes (unit_id);

COMMENT ON TABLE public.org_unit_scopes IS
  'Maps a unit to the revenue it owns (clients / service categories / services). Without this a unit is just a label; with it, unit-scoped ownership rules are computable.';

-- ── 2. Ownership programs ──────────────────────────────────────────────────
-- The "what, when, and from what". Every reward type the business will ever
-- want is a row here:
--
--   Revenue share       basis=billing  period=monthly    scope=any
--   Monthly profit share basis=profit  period=monthly    scope=company
--   Quarterly incentive  basis=profit  period=quarterly  scope=company
--   Yearly profit share  basis=profit  period=yearly     scope=company
--   Festival bonus       basis=fixed   period=one_time
--   Performance bonus    basis=profit  period=one_time
--   Campaign incentive   basis=billing period=one_time   scope=client/service
--
-- `program_type` is a LABEL for the UI. Behaviour is entirely basis +
-- period_type + scope, which is why a new reward idea never needs new code.
CREATE TABLE IF NOT EXISTS public.ownership_programs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  program_type   text NOT NULL DEFAULT 'revenue_share',   -- display label only
  basis          text NOT NULL CHECK (basis IN ('billing','collected','profit','fixed')),
  period_type    text NOT NULL DEFAULT 'monthly'
                   CHECK (period_type IN ('monthly','quarterly','yearly','one_time')),
  scope_kind     text NOT NULL DEFAULT 'company'
                   CHECK (scope_kind IN ('company','client','service','service_category','org_unit')),
  scope_id       uuid,                                     -- null iff scope_kind='company'
  /** one_time programs use these as the period; ignored otherwise. */
  period_start   date,
  period_end     date,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  is_active      boolean NOT NULL DEFAULT true,
  notes          text,
  created_by     uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'company') = (scope_id IS NULL)),
  -- Profit is a company-wide figure; scoping it to one client would be a
  -- number the profit engine cannot produce.
  CHECK (basis <> 'profit' OR scope_kind = 'company'),
  -- Cash entries carry a client but no service dimension.
  CHECK (basis <> 'collected' OR scope_kind IN ('company','client','org_unit')),
  CHECK (period_type <> 'one_time' OR (period_start IS NOT NULL AND period_end IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ownership_programs_active_idx ON public.ownership_programs (is_active, period_type);

-- ── 3. Ownership rules ─────────────────────────────────────────────────────
-- The "who and how much". A rule targets either ONE employee or a whole
-- DESIGNATION; employee-specific rules override designation rules for that
-- employee within the same program. `label` is the person's "hat" for this
-- program (Team Lead, Ops Manager, HR) — which is how one person holds several
-- responsibilities without multi-designation rewiring the permission system.
CREATE TABLE IF NOT EXISTS public.ownership_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       uuid NOT NULL REFERENCES public.ownership_programs(id) ON DELETE CASCADE,
  employee_id      uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  designation_id   uuid REFERENCES public.designations(id) ON DELETE CASCADE,
  percent          numeric(9,4) CHECK (percent IS NULL OR percent >= 0),
  fixed_amount_inr numeric(14,2) CHECK (fixed_amount_inr IS NULL OR fixed_amount_inr >= 0),
  label            text,
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  effective_to     date,
  is_active        boolean NOT NULL DEFAULT true,
  notes            text,
  created_by       uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((employee_id IS NULL) <> (designation_id IS NULL)),   -- exactly one target
  CHECK ((percent IS NULL) <> (fixed_amount_inr IS NULL))      -- exactly one amount
);
CREATE INDEX IF NOT EXISTS ownership_rules_program_idx ON public.ownership_rules (program_id, is_active);
CREATE INDEX IF NOT EXISTS ownership_rules_employee_idx ON public.ownership_rules (employee_id);

-- ── 4. Ownership awards ────────────────────────────────────────────────────
-- Immutable computed results. Keyed on a DATE RANGE rather than (month, year)
-- so quarterly, yearly and one-off periods need no schema change — the single
-- decision that would otherwise force a redesign the first time a quarterly
-- incentive is wanted.
--
-- No status machine: paying the payroll IS the approval, and locking the month
-- IS the freeze. Those states exist to coordinate multiple people.
CREATE TABLE IF NOT EXISTS public.ownership_awards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       uuid NOT NULL REFERENCES public.ownership_programs(id) ON DELETE CASCADE,
  rule_id          uuid NOT NULL REFERENCES public.ownership_rules(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  basis            text NOT NULL,                 -- snapshot of program.basis
  basis_amount_inr numeric(14,2) NOT NULL DEFAULT 0,
  percent          numeric(9,4),                  -- snapshot of the rule
  fixed_amount_inr numeric(14,2),
  earned_inr       numeric(14,2) NOT NULL DEFAULT 0,
  /** Payroll month this was paid into (period_end's month by default). */
  booked_month     integer CHECK (booked_month BETWEEN 1 AND 12),
  booked_year      integer CHECK (booked_year BETWEEN 2000 AND 2200),
  breakdown        jsonb,                         -- full inputs = audit trail
  computed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, rule_id, employee_id, period_start)
);
CREATE INDEX IF NOT EXISTS ownership_awards_booked_idx ON public.ownership_awards (booked_year, booked_month, employee_id);
CREATE INDEX IF NOT EXISTS ownership_awards_employee_idx ON public.ownership_awards (employee_id, period_start);

COMMENT ON COLUMN public.ownership_awards.breakdown IS
  'Every input behind this number (scope resolution, aggregate composition, rule source). This is the audit history — an award is never recomputed in place once its month is closed.';

-- ── 5. Payroll component ───────────────────────────────────────────────────
-- Defaults to 0, so net = base + commission + adjustment + 0 - deductions is
-- arithmetically identical to today for anyone with no ownership rules.
ALTER TABLE public.payroll
  ADD COLUMN IF NOT EXISTS ownership_earned numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payroll.ownership_earned IS
  'Ownership rewards booked into this payslip. Itemised per program on the payslip from ownership_awards.';

-- ── 6. Permissions ─────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('payroll', 'manage_ownership', 'payroll.manage_ownership', 'Manage Ownership Programs',
   'Create and edit ownership programs and rules — revenue share, profit share, incentives and bonuses. Exposes company profit and every participant''s share.', 62),
  ('settings', 'manage_org', 'settings.manage_org', 'Manage Organization',
   'Create and edit departments, teams, branches, regions and client groups, their managers, members and revenue scopes.', 63)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('payroll.manage_ownership', 'settings.manage_org')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
