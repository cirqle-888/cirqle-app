-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Advertising — client wallet ledger                                       ║
-- ║                                                                            ║
-- ║  Financial flow:                                                          ║
-- ║    Meta top-up (Cashbook outflow)                                          ║
-- ║      → CREDIT client wallet   (kind 'topup', cashbook_entry_id set)        ║
-- ║      → DEBIT  to a campaign   (kind 'campaign_allocation', ad_project_id)  ║
-- ║      → service charge = Σ campaign debits × %  → task billing → invoice    ║
-- ║                                                                            ║
-- ║  This is a proper ledger: every movement is a transaction row; balances    ║
-- ║  are ALWAYS derived (Σ credits − Σ debits), never stored. Soft-deleted     ║
-- ║  rows remain for audit. Amounts are GST-inclusive actual paid money —      ║
-- ║  platform-reported spend stays reporting-only.                             ║
-- ║                                                                            ║
-- ║  Supersedes ad_fund_allocations (20260703120000): active rows are          ║
-- ║  backfilled below as credit+debit pairs (net-zero wallet impact,           ║
-- ║  identical campaign billing basis), then soft-deleted. Rows whose          ║
-- ║  project has no client stay active — the billing engine still reads        ║
-- ║  them as a legacy fallback.                                                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_wallet_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  kind              TEXT NOT NULL CHECK (kind IN ('topup','campaign_allocation','adjustment')),
  -- Provenance links (enforced per kind below)
  cashbook_entry_id UUID REFERENCES public.cashbook_entries(id) ON DELETE RESTRICT,
  ad_project_id     UUID REFERENCES public.ad_projects(id)      ON DELETE CASCADE,
  -- GST-inclusive actual money, in the source currency + INR normalisation
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  amount_inr        NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  created_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,           -- soft delete: row stays for audit

  -- Valid (direction, kind) combinations + required provenance:
  CONSTRAINT ad_wallet_ledger_shape CHECK (
    (direction = 'credit' AND kind = 'topup'               AND cashbook_entry_id IS NOT NULL AND ad_project_id IS NULL)
    OR (direction = 'debit'  AND kind = 'campaign_allocation' AND ad_project_id IS NOT NULL)
    OR (kind = 'adjustment')
  )
);

CREATE INDEX IF NOT EXISTS ad_wallet_ledger_client_idx
  ON public.ad_wallet_ledger (client_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ad_wallet_ledger_project_idx
  ON public.ad_wallet_ledger (ad_project_id) WHERE deleted_at IS NULL AND direction = 'debit';
CREATE INDEX IF NOT EXISTS ad_wallet_ledger_entry_idx
  ON public.ad_wallet_ledger (cashbook_entry_id) WHERE deleted_at IS NULL;

-- RLS: house pattern (authenticated full access; authorization enforced in the
-- guarded server actions, matching the advertising module tables).
ALTER TABLE public.ad_wallet_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_wallet_ledger_select" ON public.ad_wallet_ledger;
CREATE POLICY "ad_wallet_ledger_select" ON public.ad_wallet_ledger
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "ad_wallet_ledger_write" ON public.ad_wallet_ledger;
CREATE POLICY "ad_wallet_ledger_write" ON public.ad_wallet_ledger
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Backfill from ad_fund_allocations (direct entry→campaign rows) ──────────
-- Each legacy row becomes a wallet credit (top-up share → the project's client)
-- plus a matching campaign debit: wallet balance nets to zero and the campaign
-- billing basis is unchanged.
INSERT INTO public.ad_wallet_ledger
  (client_id, direction, kind, cashbook_entry_id, amount, amount_inr, notes, created_by, created_at)
SELECT p.client_id, 'credit', 'topup', a.cashbook_entry_id, a.amount, a.amount_inr,
       COALESCE(a.notes, '') || ' [migrated from direct campaign allocation]',
       a.created_by, a.created_at
  FROM public.ad_fund_allocations a
  JOIN public.ad_projects p ON p.id = a.ad_project_id
 WHERE a.deleted_at IS NULL AND p.client_id IS NOT NULL;

INSERT INTO public.ad_wallet_ledger
  (client_id, direction, kind, ad_project_id, amount, amount_inr, notes, created_by, created_at)
SELECT p.client_id, 'debit', 'campaign_allocation', a.ad_project_id, a.amount, a.amount_inr,
       a.notes, a.created_by, a.created_at
  FROM public.ad_fund_allocations a
  JOIN public.ad_projects p ON p.id = a.ad_project_id
 WHERE a.deleted_at IS NULL AND p.client_id IS NOT NULL;

-- Retire the migrated legacy rows (clientless projects keep theirs — the
-- billing engine still reads those as a fallback).
UPDATE public.ad_fund_allocations a
   SET deleted_at = NOW()
  FROM public.ad_projects p
 WHERE p.id = a.ad_project_id
   AND a.deleted_at IS NULL
   AND p.client_id IS NOT NULL;

COMMIT;
