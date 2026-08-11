-- Rollback for 20260811120000: restore the original detection function
-- (20260728130000 verbatim) — manual links are once again overwritten by any
-- task edit that re-fires detection.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_task_retainer_coverage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id UUID;
  v_when    DATE := COALESCE(NEW.task_date, CURRENT_DATE);
BEGIN
  IF NEW.client_id IS NOT NULL AND NEW.service_id IS NOT NULL THEN
    SELECT i.id INTO v_item_id
      FROM public.client_agreement_items i
      JOIN public.client_agreements a ON a.id = i.agreement_id
     WHERE a.client_id      = NEW.client_id
       AND a.status         = 'active'
       AND a.deleted_at     IS NULL
       AND i.commitment_type = 'retainer'
       AND i.service_id      = NEW.service_id
       AND i.effective_from <= v_when
       AND (i.effective_to IS NULL OR i.effective_to >= v_when)
       AND a.start_date     <= v_when
       AND (a.end_date IS NULL OR a.end_date >= v_when)
     ORDER BY i.effective_from DESC
     LIMIT 1;
  END IF;

  NEW.retainer_item_id := v_item_id;  -- NULL when nothing covers it
  RETURN NEW;
END;
$$;

COMMIT;
