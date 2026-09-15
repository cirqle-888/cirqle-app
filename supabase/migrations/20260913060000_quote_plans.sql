-- Quote Planner — price a package before it is sold, and see what it does.
--
-- A quote is a hypothesis: "this client pays X a month for N of these, for T
-- months". The planner answers what that totals, what reaches staff, what each
-- of them earns at a given performance rating, and what is left over.
--
-- WHAT THESE TABLES ARE NOT: a second pricing basis. Nothing here prices a
-- task, sizes a real pool, or reaches payroll. `quote_plan_lines.unit_price`
-- is what the CLIENT would be charged in a proposal; the live money path is
-- still `tasks.billing_amount_inr × client_service_pricing.commission_percentage`
-- and is untouched by anything in this migration. The retired Client
-- Agreements module failed precisely by introducing a second basis that drifted
-- from the matrix — there is no equivalent here.
--
-- The arithmetic lives in src/lib/quote-planner/, which calls the real
-- `calculateCommission()`. These tables only remember the inputs.

BEGIN;

-- ── 1. The plan ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quote_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: a plan often exists before anyone decides who it is for.
  client_id       UUID REFERENCES public.clients(id) ON DELETE SET NULL,

  name            TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'won', 'lost')),

  -- What the client is quoted in. INR is always shown alongside, converted at
  -- the exchange_rates rate at the time the plan is opened.
  currency        TEXT NOT NULL DEFAULT 'INR',

  term_months     INT NOT NULL DEFAULT 12 CHECK (term_months >= 0),

  -- Whether the margin block apportions company base salaries and recurring
  -- expenses to this deal. Off by default: an allocated figure is a modelling
  -- choice, and it should be one somebody opted into.
  include_overheads BOOLEAN NOT NULL DEFAULT FALSE,

  -- The quotation this plan was turned into, if it ever was. ON DELETE SET
  -- NULL so deleting a quotation leaves the planning behind it intact.
  quotation_id    UUID REFERENCES public.quotations(id) ON DELETE SET NULL,

  notes           TEXT,
  created_by      UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS quote_plans_client_idx
  ON public.quote_plans (client_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS quote_plans_recent_idx
  ON public.quote_plans (updated_at DESC) WHERE deleted_at IS NULL;

-- ── 2. What is being quoted ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quote_plan_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           UUID NOT NULL REFERENCES public.quote_plans(id) ON DELETE CASCADE,
  service_id        UUID NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,

  -- Units per month. A one-off line is a plan with term_months = 1.
  monthly_quantity  NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (monthly_quantity >= 0),

  -- What the client would pay per unit. Seeded from the pricing matrix, then
  -- edited freely — quoting is exactly when somebody wants a different number.
  unit_price        NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'INR',

  -- Share of billing that becomes the employee pool. NULL means "use the
  -- client's matrix value, or 50 when there is none" — the same fallback every
  -- caller of calculateCommission already uses. Stored nullable rather than
  -- defaulted to 50 so a plan does not silently freeze today's percentage.
  commission_pct    NUMERIC(5,2) CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100)),

  display_order     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quote_plan_lines_plan_idx
  ON public.quote_plan_lines (plan_id, display_order);

-- ── 3. Who earns what ────────────────────────────────────────────────────────
-- One row per (line, employee, parameter). These are the planner's shares —
-- the "adjust contribution group and parameters" lever — and they are fed to
-- the real commission engine as synthetic contributions. They are NEVER
-- written to public.contributions.
CREATE TABLE IF NOT EXISTS public.quote_plan_shares (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID NOT NULL REFERENCES public.quote_plans(id) ON DELETE CASCADE,
  line_id       UUID NOT NULL REFERENCES public.quote_plan_lines(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  parameter_id  UUID NOT NULL REFERENCES public.parameters(id) ON DELETE CASCADE,

  share_pct     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (share_pct >= 0),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (line_id, employee_id, parameter_id)
);

CREATE INDEX IF NOT EXISTS quote_plan_shares_plan_idx
  ON public.quote_plan_shares (plan_id);

-- ── 4. The performance ratings this plan models ──────────────────────────────
-- Separate from shares because a rating is per employee per PLAN, not per line.
CREATE TABLE IF NOT EXISTS public.quote_plan_ratings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID NOT NULL REFERENCES public.quote_plans(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  rating_pct    NUMERIC(5,2) NOT NULL CHECK (rating_pct >= 0 AND rating_pct <= 100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, employee_id)
);

-- ── 5. Costs the engines do not know about ───────────────────────────────────
-- A print run, a freelancer, a licence. Measured, not allocated: these are
-- costs OF this deal, entered deliberately, and they subtract from deal margin.
CREATE TABLE IF NOT EXISTS public.quote_plan_costs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID NOT NULL REFERENCES public.quote_plans(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'INR',
  cadence     TEXT NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('once', 'monthly')),
  display_order INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quote_plan_costs_plan_idx
  ON public.quote_plan_costs (plan_id, display_order);

COMMENT ON TABLE public.quote_plans IS
  'A priced proposal being modelled. Never prices a task or sizes a real contribution pool — see src/lib/quote-planner.';
COMMENT ON COLUMN public.quote_plan_lines.commission_pct IS
  'Pool share override. NULL = use client_service_pricing.commission_percentage, falling back to 50.';
COMMENT ON TABLE public.quote_plan_shares IS
  'Planned contribution shares, fed to calculateCommission as synthetic contributions. Never written to public.contributions.';

-- ── 6. RLS (house pattern: permissive; real authz is app-level guards) ───────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_plans','quote_plan_lines','quote_plan_shares','quote_plan_ratings','quote_plan_costs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ── 7. Permissions ───────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('quote_planner', 'view',   'quote_planner.view',   'View Quote Planner',
    'Open priced proposals and see their totals and margin',            87),
  ('quote_planner', 'manage', 'quote_planner.manage', 'Manage Quote Plans',
    'Create and edit quote plans, their lines, shares and costs',        88)
ON CONFLICT (key) DO NOTHING;

COMMIT;
