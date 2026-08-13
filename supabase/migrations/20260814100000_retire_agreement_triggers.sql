-- Retire the client-agreement engine from the DATABASE.
--
-- The agreement app code was removed, but Postgres kept enforcing the old
-- behaviour: three triggers still fired on every task write, stamping
-- tasks.retainer_item_id / work_value* from client_agreement_items, and the
-- invoice trigger still suppressed the invoice line for any task it considered
-- "covered". With AGR-2607-062 still status='active', a brand-new task for that
-- client was silently marked non-billable and never reached an invoice.
--
-- This migration stops that. It is deliberately CONSERVATIVE:
--   • trigger BINDINGS are dropped, the FUNCTIONS are left in place — dropping a
--     binding is instantly reversible and cannot break anything that still
--     references the function by name.
--   • the agreement TABLES and their rows are untouched. They are the historical
--     record of what was actually agreed and invoiced; nothing reads them now.
--   • tasks.retainer_item_id / work_value* columns are left in place, still
--     holding their last stamped values. Dropping them is a separate decision.
--
-- The replacement (client_packages) links tasks explicitly from the task form,
-- never from a trigger — that silent matching is what made the old system fail.

BEGIN;

-- 1. Restore auto_attach_task_to_invoice() to its PRE-AGREEMENT body.
--    Verbatim from supabase/rollbacks/20260728130000_retainer_coverage_down.sql,
--    which preserved the original from 20260701120000_billing_sync_hardening.sql.
--    The only thing removed versus the current live body is the coverage guard
--    (v_new_billable / v_old_billable), so every task with a client bills again.
--    Phase 4 re-introduces a single package check here.
--
--    Only CREATE OR REPLACE is needed: the trigger binding itself predates the
--    tracked migrations and stays as it is, picking up this new body.
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

-- 2. Stop the coverage + work-value stamping.
--    Bindings only. set_task_retainer_coverage() and set_task_work_value()
--    remain defined, so re-creating these two triggers restores the old
--    behaviour exactly if this ever needs reversing.
DROP TRIGGER IF EXISTS trg_task_retainer_coverage ON public.tasks;
DROP TRIGGER IF EXISTS trg_task_work_value        ON public.tasks;

-- 3. Close out the live agreement so nothing treats it as current.
--    'completed' (not 'cancelled') — the work under it was delivered and
--    invoiced; it is being superseded by a package, not written off.
--    Rows are kept as the historical record.
UPDATE public.client_agreements
   SET status = 'completed', updated_at = NOW()
 WHERE status = 'active'
   AND deleted_at IS NULL;

COMMIT;
