-- Ad funds autopilot — Meta billing sync, one-step top-ups, spend-based billing.
--
-- Additive and idempotent. What it adds:
--
--   1. cashbook_entries.ad_account_id — marks an outflow as a TOP-UP paid into
--      that ad account. A top-up is wallet funding, not a rebillable expense:
--      syncDraftInvoiceExpenses never copies it onto an invoice, because the
--      client is billed the ACTUAL platform spend (incl. 18% GST) instead.
--
--   2. ad_accounts.billing_* — the account's billing snapshot from Meta
--      (available prepaid balance, lifetime amount spent, funding source text,
--      last sync time / error).
--
--   3. ad_funding_events — every funding / billing event Meta reports for an
--      account (funding_event_initiated / _successful, billing charges,
--      refunds…). A successful funding event is matched to the Cashbook entry
--      that recorded it; one with no entry surfaces as "which client is this
--      for?"; an initiated event that never succeeded surfaces as FAILED.
--
--   4. ad_campaign_daily_spend — account-level daily spend per campaign, for
--      EVERY campaign in the account (mapped or not). This is the statement's
--      source of truth and how un-mapped (= un-billable) spend gets caught.
--
--   5. invoice_expense_items gains kind='ad_spend' lines: one per campaign per
--      month on the client's draft invoice, amount = spend × 1.18. These lines
--      have no Cashbook entry (cashbook_entry_id becomes nullable — the
--      UNIQUE "bill once" rule is unaffected, NULLs never collide) and are
--      unique per (invoice, campaign, month). Every existing invoice-total
--      recalculation already sums invoice_expense_items, so totals include the
--      ad spend with no further changes.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cashbook_entries
  ADD COLUMN IF NOT EXISTS ad_account_id UUID REFERENCES public.ad_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS cashbook_entries_ad_account_idx
  ON public.cashbook_entries (ad_account_id) WHERE ad_account_id IS NOT NULL;

-- 2 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.ad_accounts
  ADD COLUMN IF NOT EXISTS billing_available_balance NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS billing_amount_spent      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS billing_funding_display   TEXT,
  ADD COLUMN IF NOT EXISTS billing_is_prepay         BOOLEAN,
  ADD COLUMN IF NOT EXISTS billing_synced_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_sync_error        TEXT;

-- 3 ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_funding_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_account_id       UUID NOT NULL REFERENCES public.ad_accounts(id) ON DELETE CASCADE,
  -- Stable identity of the provider event (type + time + object) — upsert key.
  event_key           TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  -- initiated | successful | failed | charge | refund | other
  status              TEXT NOT NULL,
  amount              NUMERIC(14,2),
  currency            TEXT,
  event_time          TIMESTAMPTZ NOT NULL,
  extra_data          JSONB,
  -- Matching / triage
  cashbook_entry_id   UUID REFERENCES public.cashbook_entries(id) ON DELETE SET NULL,
  suggested_client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  matched_at          TIMESTAMPTZ,
  dismissed_at        TIMESTAMPTZ,
  dismissed_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ad_funding_events_status_chk
    CHECK (status IN ('initiated','successful','failed','charge','refund','other')),
  CONSTRAINT ad_funding_events_key_uq UNIQUE (ad_account_id, event_key)
);
CREATE INDEX IF NOT EXISTS ad_funding_events_account_time_idx
  ON public.ad_funding_events (ad_account_id, event_time DESC);
CREATE INDEX IF NOT EXISTS ad_funding_events_entry_idx
  ON public.ad_funding_events (cashbook_entry_id) WHERE cashbook_entry_id IS NOT NULL;

-- 4 ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_campaign_daily_spend (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_account_id         UUID NOT NULL REFERENCES public.ad_accounts(id) ON DELETE CASCADE,
  external_campaign_id  TEXT NOT NULL,
  campaign_name         TEXT,
  spend_date            DATE NOT NULL,
  -- Platform-reported spend, EXCLUDING GST, in the account currency.
  spend                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency              TEXT,
  impressions           BIGINT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ad_campaign_daily_spend_uq UNIQUE (ad_account_id, external_campaign_id, spend_date)
);
CREATE INDEX IF NOT EXISTS ad_campaign_daily_spend_date_idx
  ON public.ad_campaign_daily_spend (spend_date);

-- 5 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoice_expense_items
  ALTER COLUMN cashbook_entry_id DROP NOT NULL;
ALTER TABLE public.invoice_expense_items
  ADD COLUMN IF NOT EXISTS kind          TEXT NOT NULL DEFAULT 'expense',
  ADD COLUMN IF NOT EXISTS ad_project_id UUID REFERENCES public.ad_projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ad_period     TEXT;   -- 'YYYY-MM'

DO $$ BEGIN
  ALTER TABLE public.invoice_expense_items ADD CONSTRAINT invoice_expense_items_kind_chk
    CHECK (kind IN ('expense','ad_spend'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A Cashbook-rebilled expense must still point at its entry; only ad_spend
-- lines may stand alone, and they must say which campaign + month they bill.
DO $$ BEGIN
  ALTER TABLE public.invoice_expense_items ADD CONSTRAINT invoice_expense_items_shape_chk
    CHECK (
      (kind = 'expense'  AND cashbook_entry_id IS NOT NULL)
   OR (kind = 'ad_spend' AND ad_project_id IS NOT NULL AND ad_period IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_expense_items_ad_spend_uq
  ON public.invoice_expense_items (invoice_id, ad_project_id, ad_period)
  WHERE kind = 'ad_spend';

-- 6 ─────────────────────────────────────────────────────────────────────────
-- Expense auto-rebilling: same function as 20260714093000 with one new rule —
-- an outflow carrying ad_account_id (an ad top-up) behaves like "not client-
-- billable": it detaches any draft line and never attaches. Clearing the
-- ad_account_id counts as a becoming-billable transition.
CREATE OR REPLACE FUNCTION auto_attach_expense_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_period      DATE;
  v_rate        NUMERIC(18,6);
  v_invoice_id  UUID;
  v_inv_currency TEXT;
  v_item_inv    UUID;
  v_item_status TEXT;
  v_should_add  BOOLEAN;
BEGIN
  -- ── Detach path: removed / soft-deleted / untagged / inflow / company books ─
  IF TG_OP = 'DELETE'
     OR NEW.deleted_at IS NOT NULL
     OR COALESCE(NEW.type, '') <> 'outflow'
     OR NEW.client_id IS NULL
     OR NEW.scope IS NOT DISTINCT FROM 'company'
     -- Ad top-up (wallet funding): never rebilled — the client is billed the
     -- actual ad spend instead (kind='ad_spend' lines). 20261027120000.
     OR NEW.ad_account_id IS NOT NULL
  THEN
    SELECT ii.invoice_id, i.status INTO v_item_inv, v_item_status
      FROM invoice_expense_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.cashbook_entry_id = COALESCE(OLD.id, NEW.id)
     LIMIT 1;

    IF v_item_inv IS NOT NULL AND v_item_status IN ('draft', 'reviewed') THEN
      DELETE FROM invoice_expense_items WHERE cashbook_entry_id = COALESCE(OLD.id, NEW.id);
      PERFORM recalc_invoice_totals(v_item_inv);
    END IF;

    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Here: NEW is an active OUTFLOW tagged to a client on the client's books.

  -- Already billed? Propagate edits onto a draft/reviewed line (keep markup);
  -- leave sent/paid invoices untouched; never re-add elsewhere.
  SELECT ii.invoice_id, i.status INTO v_item_inv, v_item_status
    FROM invoice_expense_items ii JOIN invoices i ON i.id = ii.invoice_id
   WHERE ii.cashbook_entry_id = NEW.id
   LIMIT 1;

  IF v_item_inv IS NOT NULL THEN
    IF v_item_status IN ('draft', 'reviewed') THEN
      UPDATE invoice_expense_items
         SET description         = COALESCE(NULLIF(NEW.description, ''), description),
             original_amount     = NEW.amount,
             original_amount_inr = NEW.amount_inr,
             amount              = NEW.amount     + COALESCE(markup_amount, 0),
             amount_inr          = NEW.amount_inr + COALESCE(markup_amount, 0) * rate_to_inr_for(NEW.currency),
             currency            = COALESCE(NEW.currency, 'INR')
       WHERE cashbook_entry_id = NEW.id;
      PERFORM recalc_invoice_totals(v_item_inv);
    END IF;
    RETURN NEW;
  END IF;

  -- Not billed yet. Only auto-attach on INSERT or a becoming-billable
  -- transition, so a manual removal is respected (a plain edit won't re-add).
  v_should_add := (TG_OP = 'INSERT')
     OR (TG_OP = 'UPDATE' AND (
            (OLD.client_id IS NULL AND NEW.client_id IS NOT NULL)
         OR (COALESCE(OLD.type, '') <> 'outflow' AND NEW.type = 'outflow')
         OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
         OR (OLD.scope IS NOT DISTINCT FROM 'company' AND NEW.scope IS DISTINCT FROM 'company')
         OR (OLD.ad_account_id IS NOT NULL AND NEW.ad_account_id IS NULL)
        ));

  IF NOT v_should_add THEN
    RETURN NEW;
  END IF;

  v_period     := DATE_TRUNC('month', COALESCE(NEW.entry_date, CURRENT_DATE))::DATE;
  v_rate       := rate_to_inr_for(NEW.currency);
  v_invoice_id := find_or_create_client_month_draft(NEW.client_id, v_period, NEW.currency, v_rate);

  -- Currency guard: only auto-attach when the draft's currency matches the entry
  -- (avoids introducing an FX conversion automatically — the badge surfaces the rest).
  SELECT COALESCE(currency, 'INR') INTO v_inv_currency FROM invoices WHERE id = v_invoice_id;
  IF v_inv_currency <> COALESCE(NEW.currency, 'INR') THEN
    RETURN NEW;
  END IF;

  INSERT INTO invoice_expense_items (
    invoice_id, cashbook_entry_id, description, amount, amount_inr, currency,
    original_amount, original_amount_inr, markup_type, markup_value, markup_amount
  ) VALUES (
    v_invoice_id, NEW.id, COALESCE(NULLIF(NEW.description, ''), 'Expense'),
    NEW.amount, NEW.amount_inr, COALESCE(NEW.currency, 'INR'),
    NEW.amount, NEW.amount_inr, 'none', 0, 0
  )
  ON CONFLICT (cashbook_entry_id) DO NOTHING;

  PERFORM recalc_invoice_totals(v_invoice_id);

  RETURN NEW;
END;
$$;


-- RLS: writes go through guarded server actions / the cron (service role);
-- signed-in users may read, matching the advertising module tables.
ALTER TABLE public.ad_funding_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_campaign_daily_spend ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_funding_events_select" ON public.ad_funding_events;
CREATE POLICY "ad_funding_events_select" ON public.ad_funding_events
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ad_campaign_daily_spend_select" ON public.ad_campaign_daily_spend;
CREATE POLICY "ad_campaign_daily_spend_select" ON public.ad_campaign_daily_spend
  FOR SELECT TO authenticated USING (true);

COMMIT;
