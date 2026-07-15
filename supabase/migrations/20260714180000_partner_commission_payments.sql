-- Business Partner commission register.
--
-- There are no commission AGREEMENTS in Cirqle — the rate is decided each time
-- in the planner on the partner dashboard. So this table records the only thing
-- that is a hard fact: money actually handed over. "Pending" is never stored;
-- it is derived at read time as (commission earned at today's rate) − (paid),
-- because the rate itself can change between payouts.
--
-- Each row snapshots the percent/basis it was computed under, so a payout made
-- at 10% of net-collected still reads correctly after the rate moves to 12%.

CREATE TABLE IF NOT EXISTS public.partner_commission_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   UUID NOT NULL REFERENCES public.business_partners(id) ON DELETE CASCADE,

  amount_inr   NUMERIC(14,2) NOT NULL CHECK (amount_inr > 0),
  paid_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  method       TEXT CHECK (method IN ('bank_transfer','upi','cash','cheque','adjustment','other')),
  reference    TEXT,

  -- What the payout was computed under, for the audit trail. Nullable: an
  -- ad-hoc/goodwill payment need not correspond to any basis at all.
  percent      NUMERIC(5,2) CHECK (percent >= 0 AND percent <= 100),
  basis        TEXT CHECK (basis IN ('net_collected','net_invoiced','profit')),
  period_from  DATE,
  period_to    DATE,

  notes        TEXT,
  created_by   UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,                -- soft delete: the row stays for audit

  CONSTRAINT partner_commission_period_order CHECK (
    period_from IS NULL OR period_to IS NULL OR period_from <= period_to
  )
);

CREATE INDEX IF NOT EXISTS partner_commission_payments_partner_idx
  ON public.partner_commission_payments (partner_id, paid_on DESC)
  WHERE deleted_at IS NULL;

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- The app reads and writes this table exclusively through the service role
-- (lib/partners/queries.ts + the partner server actions), which bypasses RLS —
-- writes are already gated by requirePermission(PERMS.PARTNERS_EDIT).
--
-- Unlike business_partners (whose SELECT policy is `USING (true)`, readable by
-- the anon key), payout amounts are money data with no reason to be reachable
-- from a public key, so SELECT is restricted to authenticated sessions.
ALTER TABLE public.partner_commission_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "partner_commission_payments_select" ON public.partner_commission_payments;
CREATE POLICY "partner_commission_payments_select" ON public.partner_commission_payments
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "partner_commission_payments_write" ON public.partner_commission_payments;
CREATE POLICY "partner_commission_payments_write" ON public.partner_commission_payments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE public.partner_commission_payments IS
  'Commission actually paid to a business partner. A register of payouts, not an agreement — the rate lives in the planner and can change per payout, so each row snapshots the percent/basis used.';
