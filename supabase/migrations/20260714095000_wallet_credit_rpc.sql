-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Finance Foundation — Phase 4: atomic wallet credit                       ║
-- ║                                                                            ║
-- ║  credit_ad_wallet() moves the over-crediting guard INTO the database:     ║
-- ║  it row-locks the funding cashbook entry (FOR UPDATE), so two concurrent  ║
-- ║  credits of the same entry serialize and the "total credited ≤ entry      ║
-- ║  amount" invariant can no longer be raced (the app-side check in          ║
-- ║  getEntryUncredited had a TOCTOU window).                                 ║
-- ║                                                                            ║
-- ║  p_client_id NULL credits the COMPANY wallet (20260714093000).            ║
-- ║  The app falls back to the legacy TS path when this function is absent.   ║
-- ║                                                                            ║
-- ║  Rollback: supabase/rollbacks/20260714095000_wallet_credit_rpc_down.sql   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE OR REPLACE FUNCTION public.credit_ad_wallet(
  p_client_id  UUID,           -- NULL = company wallet
  p_entry_id   UUID,
  p_amount     NUMERIC,
  p_notes      TEXT DEFAULT NULL,
  p_created_by UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry      RECORD;
  v_amount     NUMERIC := ROUND(COALESCE(p_amount, 0), 2);
  v_credited   NUMERIC;
  v_uncredited NUMERIC;
  v_amount_inr NUMERIC;
  v_id         UUID;
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero.';
  END IF;

  -- Serialize concurrent credits of the same funding entry.
  SELECT id, type, amount, amount_inr, deleted_at
    INTO v_entry
    FROM public.cashbook_entries
   WHERE id = p_entry_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cashbook entry not found.';
  END IF;
  IF v_entry.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'That cashbook entry was deleted.';
  END IF;
  IF v_entry.type <> 'outflow' THEN
    RAISE EXCEPTION 'Wallet credits must come from an outflow (payment) entry.';
  END IF;

  -- Invariant: total credited across ALL wallets stays within the entry.
  SELECT COALESCE(SUM(amount), 0) INTO v_credited
    FROM public.ad_wallet_ledger
   WHERE cashbook_entry_id = p_entry_id
     AND direction = 'credit'
     AND deleted_at IS NULL;

  v_uncredited := ROUND(COALESCE(v_entry.amount, 0) - v_credited, 2);
  IF v_amount > v_uncredited + 0.005 THEN
    RAISE EXCEPTION 'Only ₹% of this entry is still unassigned.', v_uncredited;
  END IF;

  -- INR normalisation: proportional share of the entry's stored amount_inr
  -- (mirrors the TS path exactly).
  IF COALESCE(v_entry.amount, 0) > 0 THEN
    v_amount_inr := ROUND(
      COALESCE(NULLIF(v_entry.amount_inr, 0), v_entry.amount) * (v_amount / v_entry.amount), 2);
  ELSE
    v_amount_inr := v_amount;
  END IF;

  INSERT INTO public.ad_wallet_ledger
    (client_id, direction, kind, cashbook_entry_id, amount, amount_inr, notes, created_by)
  VALUES
    (p_client_id, 'credit', 'topup', p_entry_id, v_amount, v_amount_inr,
     NULLIF(TRIM(COALESCE(p_notes, '')), ''), p_created_by)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMIT;
