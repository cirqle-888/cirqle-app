-- Accountant-entered Meta funding is already GST-inclusive. Credit exactly
-- that amount, once, when both the client and ad account are explicitly tagged.
BEGIN;
ALTER TABLE public.ad_wallet_ledger
  ADD COLUMN IF NOT EXISTS cashbook_auto_credit boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS ad_wallet_one_cashbook_auto_credit
  ON public.ad_wallet_ledger(cashbook_entry_id) WHERE cashbook_auto_credit;

CREATE OR REPLACE FUNCTION public.sync_cashbook_ad_wallet()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_manual numeric;
  v_manual_inr numeric;
  v_remaining numeric;
  v_remaining_inr numeric;
BEGIN
  -- The cashbook INSERT/UPDATE already owns the entry's row lock, the same
  -- lock used by credit_ad_wallet, so manual and automatic credits serialize.
  IF NEW.reversal_of IS NOT NULL THEN
    IF NEW.deleted_at IS NULL THEN
      UPDATE ad_wallet_ledger SET deleted_at = now()
        WHERE cashbook_entry_id = NEW.reversal_of AND direction = 'credit' AND deleted_at IS NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.deleted_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM cashbook_entries r WHERE r.reversal_of = NEW.id AND r.deleted_at IS NULL
  ) THEN
    UPDATE ad_wallet_ledger SET deleted_at = COALESCE(NEW.deleted_at, now())
      WHERE cashbook_entry_id = NEW.id AND direction = 'credit' AND deleted_at IS NULL;
    RETURN NEW;
  END IF;

  SELECT COALESCE(sum(amount),0), COALESCE(sum(amount_inr),0)
    INTO v_manual, v_manual_inr FROM ad_wallet_ledger
    WHERE cashbook_entry_id = NEW.id AND direction = 'credit'
      AND deleted_at IS NULL AND NOT cashbook_auto_credit;

  -- Once assigned, retagging money to another client/account requires a
  -- deliberate release of its existing credits, not an invisible transfer.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM ad_wallet_ledger WHERE cashbook_entry_id = NEW.id
      AND direction = 'credit' AND deleted_at IS NULL
  ) AND (OLD.client_id IS DISTINCT FROM NEW.client_id
    OR OLD.ad_account_id IS DISTINCT FROM NEW.ad_account_id
    OR OLD.currency IS DISTINCT FROM NEW.currency OR OLD.type IS DISTINCT FROM NEW.type) THEN
    -- Tagging a legacy funding entry with its ad account is allowed.
    IF NOT (OLD.ad_account_id IS NULL AND NEW.ad_account_id IS NOT NULL
      AND OLD.client_id IS NOT DISTINCT FROM NEW.client_id
      AND OLD.currency IS NOT DISTINCT FROM NEW.currency
      AND OLD.type IS NOT DISTINCT FROM NEW.type) THEN
      RAISE EXCEPTION 'Release the existing wallet credits before changing the funding client, account, currency or direction.';
    END IF;
  END IF;

  IF NEW.type <> 'outflow' OR NEW.ad_account_id IS NULL OR NEW.client_id IS NULL THEN
    UPDATE ad_wallet_ledger SET deleted_at = now()
      WHERE cashbook_entry_id = NEW.id AND cashbook_auto_credit AND deleted_at IS NULL;
    RETURN NEW;
  END IF;
  IF NEW.bank_account_id IS NULL THEN RAISE EXCEPTION 'Select the bank account used for this Meta funding payment.'; END IF;
  IF NEW.amount <= 0 OR NEW.amount_inr <= 0 THEN RAISE EXCEPTION 'Meta funding must have a positive amount.'; END IF;
  v_remaining := round(NEW.amount - v_manual, 2);
  v_remaining_inr := round(NEW.amount_inr - v_manual_inr, 2);
  IF v_remaining < 0 OR v_remaining_inr < 0 THEN
    RAISE EXCEPTION 'Funding is smaller than its existing manual wallet credits. Adjust those credits first.';
  END IF;
  IF (v_remaining = 0) <> (v_remaining_inr = 0) THEN
    RAISE EXCEPTION 'Funding currency totals differ from existing manual wallet credits. Adjust those credits first.';
  END IF;
  IF v_remaining = 0 THEN
    UPDATE ad_wallet_ledger SET deleted_at = now()
      WHERE cashbook_entry_id = NEW.id AND cashbook_auto_credit AND deleted_at IS NULL;
    RETURN NEW;
  END IF;
  INSERT INTO ad_wallet_ledger
    (client_id, direction, kind, cashbook_entry_id, amount, amount_inr, notes, cashbook_auto_credit)
  VALUES (NEW.client_id, 'credit', 'topup', NEW.id, v_remaining, v_remaining_inr,
    'Automatically credited from Cashbook Meta funding (GST included)', true)
  ON CONFLICT (cashbook_entry_id) WHERE cashbook_auto_credit DO UPDATE SET
    client_id = EXCLUDED.client_id, amount = EXCLUDED.amount, amount_inr = EXCLUDED.amount_inr,
    notes = EXCLUDED.notes, deleted_at = NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_cashbook_ad_wallet() FROM PUBLIC;
DROP TRIGGER IF EXISTS cashbook_ad_wallet_autocredit ON public.cashbook_entries;
CREATE TRIGGER cashbook_ad_wallet_autocredit
  AFTER INSERT OR UPDATE ON public.cashbook_entries
  FOR EACH ROW EXECUTE FUNCTION public.sync_cashbook_ad_wallet();
-- Periodic reconciliation also covers accountant entries saved before this
-- migration, without inserting or changing their recorded money amounts.
CREATE OR REPLACE FUNCTION public.reconcile_cashbook_ad_wallet(p_entry_id uuid)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  UPDATE cashbook_entries SET ad_account_id = ad_account_id
  WHERE id = p_entry_id AND ad_account_id IS NOT NULL AND client_id IS NOT NULL
    AND type = 'outflow' AND deleted_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.reconcile_cashbook_ad_wallet(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_cashbook_ad_wallet(uuid) TO service_role;
COMMIT;
