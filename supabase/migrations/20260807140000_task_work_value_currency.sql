-- ═══════════════════════════════════════════════════════════════════════════
-- TASK WORK VALUE IN THE AGREEMENT'S CURRENCY
--
-- 20260807110000 stamped tasks.work_value_inr (work_unit_value × qty × fx),
-- which is what the contribution engine needs — the whole pool maths is INR.
-- But every human-facing surface wants the number the agreement is written in:
-- Elara's agreement says AED 26.67 per post, and showing "₹518.09" forces the
-- reader to reverse the FX rate in their head to check it against the contract.
--
-- Deriving AED back from INR at read time would be worse: it re-divides by a
-- rate that may have moved since the stamp, so the displayed figure would drift
-- away from the agreement it is supposed to quote. Store both instead — the
-- INR one for arithmetic, the native one for display — stamped together from
-- the same source row so they can never disagree.
--
-- ADDITIVE + idempotent. Rollback:
-- supabase/rollbacks/20260807140000_task_work_value_currency_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS work_value          NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS work_value_currency TEXT;

COMMENT ON COLUMN public.tasks.work_value IS
  'Internal value of covered work in the AGREEMENT''s currency (work_unit_value × quantity). Display only — contributions pool from work_value_inr.';
COMMENT ON COLUMN public.tasks.work_value_currency IS
  'Currency of tasks.work_value — the agreement item''s currency (e.g. AED).';

-- Re-declare the stamp so it writes all three columns from one read.
CREATE OR REPLACE FUNCTION public.set_task_work_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit NUMERIC(12,2);
  v_cur  TEXT;
BEGIN
  IF NEW.retainer_item_id IS NOT NULL AND NOT COALESCE(NEW.bill_as_extra, FALSE) THEN
    SELECT work_unit_value, currency INTO v_unit, v_cur
      FROM public.client_agreement_items WHERE id = NEW.retainer_item_id;
    IF v_unit IS NULL THEN
      NEW.work_value_inr      := NULL;  -- no work value set on the agreement yet
      NEW.work_value          := NULL;
      NEW.work_value_currency := NULL;
    ELSE
      NEW.work_value          := ROUND(v_unit * COALESCE(NEW.quantity, 1), 2);
      NEW.work_value_currency := v_cur;
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

DROP TRIGGER IF EXISTS trg_task_work_value ON public.tasks;
CREATE TRIGGER trg_task_work_value
  BEFORE INSERT OR UPDATE OF client_id, service_id, task_date, quantity, bill_as_extra, retainer_item_id
  ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_work_value();

-- Re-stamp helper kept in step with the trigger.
CREATE OR REPLACE FUNCTION public.restamp_agreement_item_work_values(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.tasks t
     SET work_value_inr = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1) * rate_to_inr_for(i.currency), 2)
         END,
         work_value = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1), 2)
         END,
         work_value_currency = CASE
           WHEN i.work_unit_value IS NULL THEN NULL ELSE i.currency
         END
    FROM public.client_agreement_items i
   WHERE i.id = p_item_id
     AND t.retainer_item_id = p_item_id
     AND NOT COALESCE(t.bill_as_extra, FALSE)
     AND t.deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Backfill the two new columns on already-covered tasks.
UPDATE public.tasks t
   SET work_value = CASE
         WHEN i.work_unit_value IS NULL THEN NULL
         ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1), 2)
       END,
       work_value_currency = CASE
         WHEN i.work_unit_value IS NULL THEN NULL ELSE i.currency
       END
  FROM public.client_agreement_items i
 WHERE t.retainer_item_id = i.id
   AND NOT COALESCE(t.bill_as_extra, FALSE);

COMMIT;
