-- Rollback for 20260728130000_retainer_coverage.sql
-- Restores auto_attach_task_to_invoice() to its pre-coverage body (verbatim from
-- 20260701120000_billing_sync_hardening.sql), drops the coverage trigger/function,
-- then drops the columns. Order matters: the invoice function must stop
-- referencing retainer_item_id / bill_as_extra BEFORE the columns are dropped.
BEGIN;

-- 1. Restore the original invoicing trigger function (no coverage guard).
CREATE OR REPLACE FUNCTION public.auto_attach_task_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_billing_period DATE;
  v_invoice_id     UUID;
  v_display_order  INT;
  v_affected_inv   UUID;
  v_exchange_rate  NUMERIC(18,6);
  v_new_period     DATE;
  v_old_period     DATE;
  v_cur_inv        UUID;
  v_cur_status     TEXT;
  v_moved          BOOLEAN := FALSE;
BEGIN
  IF NEW.status = 'done'
     AND (OLD.status IS NULL OR OLD.status <> 'done')
     AND NEW.client_id IS NOT NULL
  THEN
    v_exchange_rate  := rate_to_inr_for(NEW.currency);
    v_billing_period := DATE_TRUNC('month', COALESCE(NEW.task_date, CURRENT_DATE))::DATE;
    v_invoice_id     := find_or_create_client_month_draft(NEW.client_id, v_billing_period, NEW.currency, v_exchange_rate);
    SELECT COALESCE(MAX(display_order), -1) INTO v_display_order
      FROM invoice_items WHERE invoice_id = v_invoice_id;
    INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, total, currency, display_order)
    VALUES (
      v_invoice_id, NEW.id, NEW.title, COALESCE(NEW.quantity, 1),
      COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
      COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
      COALESCE(NEW.currency, 'INR'), v_display_order + 1
    )
    ON CONFLICT (invoice_id, task_id) DO UPDATE SET
      description = EXCLUDED.description, quantity = EXCLUDED.quantity,
      unit_price = EXCLUDED.unit_price, total = EXCLUDED.total, currency = EXCLUDED.currency;
    v_affected_inv := v_invoice_id;
  ELSIF (NEW.status <> 'done' AND OLD.status = 'done')
        OR (TG_OP = 'DELETE' AND OLD.status = 'done')
  THEN
    SELECT i.id INTO v_invoice_id
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE ii.task_id = OLD.id AND i.status IN ('draft', 'reviewed')
     LIMIT 1;
    IF v_invoice_id IS NOT NULL THEN
      DELETE FROM invoice_items WHERE invoice_id = v_invoice_id AND task_id = OLD.id;
      v_affected_inv := v_invoice_id;
    END IF;
  ELSIF NEW.status = 'done' AND OLD.status = 'done' THEN
    v_new_period := DATE_TRUNC('month', COALESCE(NEW.task_date, CURRENT_DATE))::DATE;
    v_old_period := DATE_TRUNC('month', COALESCE(OLD.task_date, CURRENT_DATE))::DATE;
    SELECT i.id, i.status INTO v_cur_inv, v_cur_status
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE ii.task_id = NEW.id LIMIT 1;
    IF (NEW.client_id IS DISTINCT FROM OLD.client_id OR v_new_period <> v_old_period)
       AND NEW.client_id IS NOT NULL AND v_cur_inv IS NOT NULL
       AND v_cur_status IN ('draft', 'reviewed')
    THEN
      DELETE FROM invoice_items WHERE invoice_id = v_cur_inv AND task_id = NEW.id;
      PERFORM recalc_invoice_totals(v_cur_inv);
      v_exchange_rate := rate_to_inr_for(NEW.currency);
      v_invoice_id    := find_or_create_client_month_draft(NEW.client_id, v_new_period, NEW.currency, v_exchange_rate);
      SELECT COALESCE(MAX(display_order), -1) INTO v_display_order
        FROM invoice_items WHERE invoice_id = v_invoice_id;
      INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, total, currency, display_order)
      VALUES (
        v_invoice_id, NEW.id, NEW.title, COALESCE(NEW.quantity, 1),
        COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
        COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
        COALESCE(NEW.currency, 'INR'), v_display_order + 1
      )
      ON CONFLICT (invoice_id, task_id) DO UPDATE SET
        description = EXCLUDED.description, quantity = EXCLUDED.quantity,
        unit_price = EXCLUDED.unit_price, total = EXCLUDED.total, currency = EXCLUDED.currency;
      v_affected_inv := v_invoice_id;
      v_moved := TRUE;
    END IF;
    IF NOT v_moved
       AND (NEW.billing_amount     IS DISTINCT FROM OLD.billing_amount
        OR NEW.billing_amount_inr  IS DISTINCT FROM OLD.billing_amount_inr
        OR NEW.title               IS DISTINCT FROM OLD.title
        OR NEW.quantity            IS DISTINCT FROM OLD.quantity
        OR NEW.currency            IS DISTINCT FROM OLD.currency)
    THEN
      UPDATE invoice_items
         SET description = NEW.title, quantity = COALESCE(NEW.quantity, 1),
             unit_price = COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
             total      = COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
             currency   = COALESCE(NEW.currency, 'INR')
       WHERE task_id = NEW.id;
      SELECT invoice_id INTO v_affected_inv FROM invoice_items WHERE task_id = NEW.id LIMIT 1;
    END IF;
  END IF;
  PERFORM recalc_invoice_totals(v_affected_inv);
  RETURN NEW;
END;
$$;

-- 2. Drop the coverage detection trigger + function.
DROP TRIGGER IF EXISTS trg_task_retainer_coverage ON public.tasks;
DROP FUNCTION IF EXISTS public.set_task_retainer_coverage();

-- 3. Drop the columns.
DROP INDEX IF EXISTS public.tasks_retainer_item_idx;
ALTER TABLE public.tasks
  DROP COLUMN IF EXISTS bill_as_extra,
  DROP COLUMN IF EXISTS retainer_item_id;

COMMIT;
