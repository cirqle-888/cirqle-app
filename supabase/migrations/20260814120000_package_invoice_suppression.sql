-- Stop the invoice trigger giving a package task its own line.
--
-- A package bills as ONE line at the agreed price. The auto-attach trigger,
-- left alone, would also add a line per task inside it — billing the client the
-- fee AND every task the fee already paid for.
--
-- The condition is deliberately `package_id IS NULL` and nothing more. Whether
-- a task is *covered* or an *extra* depends on how many came before it in the
-- period, which is not something a row-level trigger can see; that judgement
-- lives in TypeScript (lib/packages/invoice-lines.ts) where it is unit-tested.
-- So the trigger simply steps aside for anything package-linked, and
-- syncInvoicePackageLines adds the fee line and any extra-task lines.
--
-- Only the two billability expressions change versus 20260814100000. The rest
-- of the body is that migration's, unchanged.

BEGIN;

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
  v_new_billable   BOOLEAN;
  v_old_billable   BOOLEAN;
BEGIN
  -- A task the app bills on its own: has a client, and is not inside a package.
  v_new_billable := (NEW.client_id IS NOT NULL AND NEW.package_id IS NULL);
  v_old_billable := (OLD.client_id IS NOT NULL AND OLD.package_id IS NULL);

  IF NEW.status = 'done'
     AND (OLD.status IS NULL OR OLD.status <> 'done')
     AND v_new_billable
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
        -- Newly inside a package: pull the line it used to have. Without this,
        -- ticking an existing task onto a package leaves its old line behind
        -- and the client is billed twice.
        OR (v_old_billable AND NOT v_new_billable)
  THEN
    SELECT i.id INTO v_invoice_id
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE ii.task_id = OLD.id AND i.status IN ('draft', 'reviewed')
     LIMIT 1;
    IF v_invoice_id IS NOT NULL THEN
      DELETE FROM invoice_items WHERE invoice_id = v_invoice_id AND task_id = OLD.id;
      v_affected_inv := v_invoice_id;
    END IF;

  ELSIF NEW.status = 'done' AND OLD.status = 'done' AND v_new_billable THEN
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

-- The trigger fires on UPDATE OF status, billing_amount_inr — so linking a task
-- to a package would not fire it and the old line would linger. Add package_id.
DROP TRIGGER IF EXISTS trg_auto_attach_task ON public.tasks;
CREATE TRIGGER trg_auto_attach_task
  AFTER INSERT OR UPDATE OF status, billing_amount_inr, package_id
  ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_attach_task_to_invoice();

COMMIT;
