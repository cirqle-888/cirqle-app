-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Advertising — Cashbook fund allocations                                  ║
-- ║                                                                            ║
-- ║  Business flow: the agency funds Meta in advance (one Cashbook outflow,   ║
-- ║  e.g. ₹20,000 top-up), then allocates portions of that entry to client    ║
-- ║  campaigns (Client A ₹5,000, Client B ₹8,000, …). The ALLOCATED amount    ║
-- ║  (GST-inclusive, what was actually paid) — not the estimated campaign     ║
-- ║  budget and not the platform-reported spend — is the basis for the        ║
-- ║  service-charge billing:                                                  ║
-- ║                                                                            ║
-- ║      task billing = Σ active allocations × service_charge_%               ║
-- ║      (or the fixed service charge, per ad_projects.service_charge_type)   ║
-- ║                                                                            ║
-- ║  Campaigns with no allocations keep the previous behaviour (billing from  ║
-- ║  the estimated ad_budget_amount), so nothing breaks on existing data.     ║
-- ║                                                                            ║
-- ║  Platform-reported spend (ad_daily_metrics.spend, usually GST-exclusive)  ║
-- ║  stays reporting-only.                                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_fund_allocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_project_id     UUID NOT NULL REFERENCES public.ad_projects(id)      ON DELETE CASCADE,
  cashbook_entry_id UUID NOT NULL REFERENCES public.cashbook_entries(id) ON DELETE RESTRICT,
  -- Allocated amount in the cashbook entry's currency + its INR normalisation
  -- (proportional share of the entry's amount_inr, frozen at allocation time).
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  amount_inr        NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  created_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ            -- soft delete (house pattern)
);

CREATE INDEX IF NOT EXISTS ad_fund_allocations_project_idx
  ON public.ad_fund_allocations (ad_project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ad_fund_allocations_entry_idx
  ON public.ad_fund_allocations (cashbook_entry_id) WHERE deleted_at IS NULL;

-- RLS: house pattern (authenticated full access; authorization enforced in the
-- guarded server actions, matching the advertising module tables).
ALTER TABLE public.ad_fund_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_fund_allocations_select" ON public.ad_fund_allocations;
CREATE POLICY "ad_fund_allocations_select" ON public.ad_fund_allocations
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "ad_fund_allocations_write" ON public.ad_fund_allocations;
CREATE POLICY "ad_fund_allocations_write" ON public.ad_fund_allocations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
