-- Rollback for 20260714093000_finance_views_company_wallet.sql
--
-- Restoring the NOT NULLs is only possible while no company-wallet rows /
-- company reports exist — the guards below abort with a clear message instead
-- of failing halfway.

BEGIN;

DROP VIEW IF EXISTS public.v_company_pnl_monthly;
DROP VIEW IF EXISTS public.v_finance_journal;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ad_wallet_ledger WHERE client_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot restore NOT NULL: company-wallet rows exist in ad_wallet_ledger. Delete or reassign them first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ad_reports WHERE client_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot restore NOT NULL: company reports exist in ad_reports. Delete them first.';
  END IF;
END $$;

DROP INDEX IF EXISTS ad_wallet_ledger_company_idx;
ALTER TABLE public.ad_wallet_ledger ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public.ad_reports      ALTER COLUMN client_id SET NOT NULL;

-- Restore the pre-scope auto_attach_expense_to_invoice() exactly as defined in
-- 20260701120000_billing_sync_hardening.sql.
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
  IF TG_OP = 'DELETE'
     OR NEW.deleted_at IS NOT NULL
     OR COALESCE(NEW.type, '') <> 'outflow'
     OR NEW.client_id IS NULL
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

  v_should_add := (TG_OP = 'INSERT')
     OR (TG_OP = 'UPDATE' AND (
            (OLD.client_id IS NULL AND NEW.client_id IS NOT NULL)
         OR (COALESCE(OLD.type, '') <> 'outflow' AND NEW.type = 'outflow')
         OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
        ));

  IF NOT v_should_add THEN
    RETURN NEW;
  END IF;

  v_period     := DATE_TRUNC('month', COALESCE(NEW.entry_date, CURRENT_DATE))::DATE;
  v_rate       := rate_to_inr_for(NEW.currency);
  v_invoice_id := find_or_create_client_month_draft(NEW.client_id, v_period, NEW.currency, v_rate);

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

COMMIT;
