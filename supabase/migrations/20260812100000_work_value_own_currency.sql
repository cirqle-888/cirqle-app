-- ═══════════════════════════════════════════════════════════════════════════
-- WORK VALUE GETS ITS OWN CURRENCY (defaulting to INR)
--
-- Work value is what the TEAM is paid from; the item's `currency` is what the
-- CLIENT is billed in. Tying the two together meant an agency paying its
-- people in INR had to express team pay in AED, and the rupee figure then
-- moved with the exchange rate: the same AED 20 stamped ₹518.09 on one task
-- and ₹518.71 on another. Payroll wobbling with FX on unchanged work is noise,
-- not signal.
--
-- Employee agreements here are written in INR, so work value should be too.
--
-- BACK-COMPATIBLE BY CONSTRUCTION. The new column is NULLABLE and every
-- existing row keeps NULL, which the trigger reads as "use the item's billing
-- currency" — byte-identical behaviour for all 8 existing work values and
-- every task already stamped from them. Only rows that explicitly set the new
-- column change behaviour, and the UI sets it to INR on new items.
--
-- Rollback: supabase/rollbacks/20260812100000_work_value_own_currency_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.client_agreement_items
  ADD COLUMN IF NOT EXISTS work_unit_currency TEXT;

COMMENT ON COLUMN public.client_agreement_items.work_unit_currency IS
  'Currency of work_unit_value — what the TEAM is paid in, independent of the client-facing `currency`. NULL = fall back to `currency` (pre-2026-08 behaviour). New items default to INR.';

-- Stamp reads the work-value currency, falling back to the billing currency.
CREATE OR REPLACE FUNCTION public.set_task_work_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit NUMERIC(12,2);
  v_cur  TEXT;
BEGIN
  -- Finalized months stay frozen (20260807150000) — unchanged.
  IF TG_OP = 'UPDATE' AND public.is_task_date_payroll_finalized(NEW.task_date) THEN
    NEW.work_value          := OLD.work_value;
    NEW.work_value_currency := OLD.work_value_currency;
    NEW.work_value_inr      := OLD.work_value_inr;
    RETURN NEW;
  END IF;

  IF NEW.retainer_item_id IS NOT NULL AND NOT COALESCE(NEW.bill_as_extra, FALSE) THEN
    -- COALESCE is the whole back-compat story: legacy rows (NULL) keep
    -- converting from the client currency exactly as before.
    SELECT work_unit_value, COALESCE(work_unit_currency, currency)
      INTO v_unit, v_cur
      FROM public.client_agreement_items WHERE id = NEW.retainer_item_id;
    IF v_unit IS NULL THEN
      NEW.work_value_inr      := NULL;
      NEW.work_value          := NULL;
      NEW.work_value_currency := NULL;
    ELSE
      NEW.work_value          := ROUND(v_unit * COALESCE(NEW.quantity, 1), 2);
      NEW.work_value_currency := v_cur;
      -- rate_to_inr_for('INR') is 1, so an INR work value is stamped exactly
      -- as typed and never drifts with the exchange rate again.
      NEW.work_value_inr      := ROUND(v_unit * COALESCE(NEW.quantity, 1) * rate_to_inr_for(v_cur), 2);
    END IF;
  ELSE
    NEW.work_value_inr      := NULL;
    NEW.work_value          := NULL;
    NEW.work_value_currency := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Bulk re-stamp helper must use the same rule or the two paths would disagree.
CREATE OR REPLACE FUNCTION public.restamp_agreement_item_work_values(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.tasks t
     SET work_value_inr = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1)
                      * rate_to_inr_for(COALESCE(i.work_unit_currency, i.currency)), 2)
         END,
         work_value = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1), 2)
         END,
         work_value_currency = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE COALESCE(i.work_unit_currency, i.currency)
         END
    FROM public.client_agreement_items i
   WHERE i.id = p_item_id
     AND t.retainer_item_id = i.id
     AND NOT COALESCE(t.bill_as_extra, FALSE)
     AND t.deleted_at IS NULL
     -- Paid/locked months keep the figures their payslips were issued with.
     AND NOT public.is_task_date_payroll_finalized(t.task_date);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMIT;
