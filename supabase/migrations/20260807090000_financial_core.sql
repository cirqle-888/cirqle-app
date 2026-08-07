-- ═══════════════════════════════════════════════════════════════════════════
-- FINANCIAL CORE — Phase 1 of the Ownership Platform
--
-- Adds the company-side financial layer: explicit period locking, one profit
-- engine's snapshots, a versioned overhead/expense policy, real recurring
-- expenses, and a prior-period adjustment ledger.
--
-- THE CONTRIBUTION ENGINE IS UNTOUCHED. Nothing here reads or writes
-- contribution_scores, the pool, ratings or tool deductions. Recurring
-- expenses land in the cashbook (company books) and affect PROFIT only —
-- they can never reduce an employee's contribution earnings. An employee with
-- no configuration in these tables has byte-identical payroll to before.
--
-- STRICTLY ADDITIVE: five new tables + one nullable-by-default column on
-- payroll. Every reader in the app is written defensively, so an environment
-- that has not applied this migration behaves exactly as it does today.
--
-- Rollback: supabase/rollbacks/20260807090000_financial_core_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Period locks ────────────────────────────────────────────────────────
-- A month is FINALIZED when any payroll row for it is 'paid' (existing rule,
-- src/lib/payroll/compute.ts) OR when it is explicitly locked here. Locking is
-- the owner's "close the books" action: it freezes the profit snapshot,
-- payroll and any ownership awards for that month. isMonthFinalized() consults
-- both sources, so every existing money-writer guard inherits this for free.
CREATE TABLE IF NOT EXISTS public.period_locks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month      integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  locked_at  timestamptz NOT NULL DEFAULT now(),
  locked_by  uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  reason     text,
  UNIQUE (month, year)
);

COMMENT ON TABLE public.period_locks IS
  'Explicitly closed financial months. Consulted by isMonthFinalized() alongside paid payroll; both freeze every money writer for that month.';

-- ── 2. Profit snapshots ────────────────────────────────────────────────────
-- Written when a month is locked. Locked months read the snapshot; open months
-- recompute live. Quarterly/yearly figures are sums of frozen months, so a
-- closed period can never drift after the fact.
CREATE TABLE IF NOT EXISTS public.profit_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month                 integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                  integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  revenue_inr           numeric(14,2) NOT NULL DEFAULT 0,
  contribution_inr      numeric(14,2) NOT NULL DEFAULT 0,
  base_salaries_inr     numeric(14,2) NOT NULL DEFAULT 0,
  expenses_inr          numeric(14,2) NOT NULL DEFAULT 0,
  profit_inr            numeric(14,2) NOT NULL DEFAULT 0,
  breakdown             jsonb,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, year)
);

COMMENT ON TABLE public.profit_snapshots IS
  'Frozen monthly profit, written at period lock. The single profit engine (src/lib/finance/profit.ts) reads these for locked months and computes live for open ones.';
COMMENT ON COLUMN public.profit_snapshots.breakdown IS
  'Full input composition (policy version, expense account codes, employee counts) — the audit trail for how this profit number was reached.';

-- ── 3. Overhead / profit-composition policy ────────────────────────────────
-- APPEND-ONLY and versioned by effective_from, per docs/architecture/
-- financial-core.md: "Overhead allocation is a policy, so make it explicit and
-- versioned rather than hardcoded in a report." One policy row drives the
-- profit engine, the expense-recovery meter and report overhead columns, so
-- every surface agrees by construction.
--
-- exclude_account_codes defaults to {opex.salaries}: those cash payments ARE
-- the salaries and commissions already subtracted from profit as
-- contribution earnings + base salaries. Counting the cash too would
-- double-count labour.
CREATE TABLE IF NOT EXISTS public.overhead_allocation_policy (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_basis      text NOT NULL DEFAULT 'billing_proportional'
                          CHECK (allocation_basis IN ('billing_proportional')),
  included_sections     text[] NOT NULL DEFAULT ARRAY['cogs','opex'],
  exclude_account_codes text[] NOT NULL DEFAULT ARRAY['opex.salaries'],
  recovery_rate_percent numeric(6,2) NOT NULL DEFAULT 20 CHECK (recovery_rate_percent >= 0),
  effective_from        date NOT NULL DEFAULT CURRENT_DATE,
  notes                 text,
  created_by            uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.overhead_allocation_policy (allocation_basis, notes)
SELECT 'billing_proportional',
       'Default v1 policy. opex.salaries excluded from expenses: labour is already subtracted as contribution earnings + base salaries, so counting the salary cash again would double-count it.'
WHERE NOT EXISTS (SELECT 1 FROM public.overhead_allocation_policy);

COMMENT ON TABLE public.overhead_allocation_policy IS
  'Versioned, append-only profit/overhead policy. Never UPDATE a row — insert a new one with a later effective_from so historical periods keep the policy they were computed under.';

-- ── 4. Recurring expenses ──────────────────────────────────────────────────
-- Rent, internet, phone, software, AI tools, utilities, insurance, office
-- costs. A daily cron posts the due occurrence into cashbook_entries, where
-- the existing scope trigger and chart of accounts take over — so the Company
-- P&L and the profit engine pick them up with no extra wiring.
--
-- NOT to be confused with the cashbook form's "repeat for N months" checkbox,
-- which materialises N independent rows immediately. That stays as-is for
-- finite series; this table is the open-ended, editable, pausable version.
CREATE TABLE IF NOT EXISTS public.recurring_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  category_id     uuid NOT NULL REFERENCES public.cashbook_categories(id),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL DEFAULT 'INR',
  amount_inr      numeric(14,2) NOT NULL CHECK (amount_inr > 0),
  -- Capped at 28 so every month has the day; no clamping rules to reason about.
  day_of_month    integer NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  frequency       text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly','yearly')),
  start_date      date NOT NULL DEFAULT CURRENT_DATE,
  end_date        date,
  bank_account_id uuid REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  client_id       uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS recurring_expenses_active_idx
  ON public.recurring_expenses (is_active, start_date);

COMMENT ON COLUMN public.recurring_expenses.amount_inr IS
  'INR snapshot taken when the rule is saved. The cron posts this value rather than converting at post time, so a rule always costs what the owner agreed to.';

-- ── 5. Prior-period adjustment ledger ──────────────────────────────────────
-- Closed books are never reopened. When work lands late (a task created with
-- last month''s date, a billing correction), the delta between what the locked
-- month actually PAID and what the engine now says it should have paid becomes
-- a row here, and is settled in the next open payroll as a visible
-- "Prior-period adjustment" line.
--
-- Analytical reports still show the work in its true month — payroll shows
-- when the money moved. This ledger is the auditable bridge between the two.
CREATE TABLE IF NOT EXISTS public.payroll_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  source_month   integer NOT NULL CHECK (source_month BETWEEN 1 AND 12),
  source_year    integer NOT NULL CHECK (source_year BETWEEN 2000 AND 2200),
  amount_inr     numeric(14,2) NOT NULL,
  reason         text NOT NULL DEFAULT 'contribution_delta',
  breakdown      jsonb,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  settled_month  integer CHECK (settled_month BETWEEN 1 AND 12),
  settled_year   integer CHECK (settled_year BETWEEN 2000 AND 2200),
  settled_at     timestamptz,
  -- One open delta per employee per closed month: re-detection updates the
  -- amount in place rather than stacking duplicate rows every cron run.
  UNIQUE (employee_id, source_month, source_year, reason)
);

CREATE INDEX IF NOT EXISTS payroll_adjustments_unsettled_idx
  ON public.payroll_adjustments (employee_id) WHERE settled_at IS NULL;

COMMENT ON TABLE public.payroll_adjustments IS
  'Deltas owed for already-closed months, settled in the next open payroll. Never modifies the source month''s payroll, snapshot or reports.';

-- ── 6. Payroll component ───────────────────────────────────────────────────
-- Defaults to 0, so net = base + commission + 0 - deductions is arithmetically
-- identical to today for every employee who has no adjustments.
ALTER TABLE public.payroll
  ADD COLUMN IF NOT EXISTS adjustment_earned numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payroll.adjustment_earned IS
  'Settled prior-period adjustments included in this payslip. Sourced from payroll_adjustments; itemised on the payslip with its origin month.';

COMMIT;
