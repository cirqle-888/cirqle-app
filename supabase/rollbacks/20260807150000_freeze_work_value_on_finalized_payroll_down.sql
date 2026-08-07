-- Rollback for 20260807150000_freeze_work_value_on_finalized_payroll.sql
--
-- Restores the unguarded stamp: agreement Work Value changes will once again
-- re-stamp tasks in FINALIZED payroll periods, so a historical task can show a
-- work value it was not actually paid from. Only roll back if that trade is
-- deliberate — earnings stay frozen either way, so the effect is purely to
-- reintroduce the mismatch between the two.

BEGIN;

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
      NEW.work_value_inr      := NULL;
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

DROP FUNCTION IF EXISTS public.is_task_date_payroll_finalized(DATE);
DROP FUNCTION IF EXISTS public.is_month_payroll_finalized(INT, INT);

COMMIT;
