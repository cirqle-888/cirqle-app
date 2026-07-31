-- ═══════════════════════════════════════════════════════════════════════════
-- RETAINER COVERAGE — stop retainer-covered tasks from client-invoicing (Ph 2)
--
-- THE double-billing fix. Today auto_attach_task_to_invoice() turns ANY task
-- that reaches 'done' (with a client + billing_amount) into an invoice line —
-- it knows nothing about agreements. So a post already paid for by a monthly
-- retainer would ALSO get its own line. This migration teaches the invoicing
-- layer about retainer coverage.
--
-- Model (both columns default to the pre-existing behaviour → backward-compatible):
--   • tasks.retainer_item_id  — auto-detected: the active retainer item whose
--                               client + service + term covers this task. NULL
--                               when nothing covers it (every existing task).
--   • tasks.bill_as_extra     — operator override for work BEYOND the monthly
--                               commitment (the 16th poster). FALSE by default.
--
--   A task is "billable to the client" when it has a client AND is NOT
--   (covered AND not-flagged-extra). Covered posts never become invoice lines;
--   the client keeps the single monthly retainer invoice. Extra work bills.
--
-- This migration is ADDITIVE + idempotent. It does NOT touch billing_amount,
-- commissions, or payroll — only whether a line is attached to an invoice.
--
-- Rollback: supabase/rollbacks/20260728130000_retainer_coverage_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS retainer_item_id UUID
    REFERENCES public.client_agreement_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bill_as_extra BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS tasks_retainer_item_idx
  ON public.tasks (retainer_item_id) WHERE retainer_item_id IS NOT NULL;

COMMENT ON COLUMN public.tasks.retainer_item_id IS
  'Auto-detected active retainer item covering this task (client+service+date). NULL = not retainer-covered.';
COMMENT ON COLUMN public.tasks.bill_as_extra IS
  'Operator override: TRUE means this covered task is EXTRA work beyond the monthly commitment and should bill the client normally.';

-- ── 2. Auto-detect coverage on every task write (BEFORE trigger) ─────────────
--     Pure detection: sets retainer_item_id, never mutates billing. Runs before
--     the AFTER invoicing trigger, so that trigger sees the fresh value.
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

DROP TRIGGER IF EXISTS trg_task_retainer_coverage ON public.tasks;
CREATE TRIGGER trg_task_retainer_coverage
  BEFORE INSERT OR UPDATE OF client_id, service_id, task_date ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_retainer_coverage();

-- ── 3. Invoice trigger: skip client-billing for covered tasks ────────────────
--     Faithful copy of 20260701120000's auto_attach_task_to_invoice, with ONE
--     structural change: everything is gated on a "billable to client" flag,
--     and CASE C now adds/removes the line when coverage flips. Covered posts
--     therefore never create an invoice line; only extra-work / normal tasks do.
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
  -- NEW: is each version of the row billable to the client?
  v_new_billable   BOOLEAN;
  v_old_billable   BOOLEAN;
BEGIN
  v_new_billable := (NEW.client_id IS NOT NULL
                     AND NOT (NEW.retainer_item_id IS NOT NULL
                              AND NOT COALESCE(NEW.bill_as_extra, FALSE)));
  v_old_billable := (OLD.client_id IS NOT NULL
                     AND NOT (OLD.retainer_item_id IS NOT NULL
                              AND NOT COALESCE(OLD.bill_as_extra, FALSE)));

  -- ── CASE A: first reaches 'done' AND billable ─────────────────────────────
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

  -- ── CASE B: leaves 'done' (or a done task is deleted) → remove line ────────
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

  -- ── CASE C: stays 'done' ──────────────────────────────────────────────────
  ELSIF NEW.status = 'done' AND OLD.status = 'done' THEN

    -- C0 (NEW): billable status flipped (coverage / extra-work toggled)
    IF v_new_billable IS DISTINCT FROM v_old_billable THEN
      IF v_new_billable THEN
        -- became billable (e.g. flagged extra work) → add a line like CASE A
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
      ELSE
        -- became covered → remove any existing line (draft/reviewed only)
        SELECT i.id INTO v_cur_inv
          FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
         WHERE ii.task_id = NEW.id AND i.status IN ('draft', 'reviewed')
         LIMIT 1;
        IF v_cur_inv IS NOT NULL THEN
          DELETE FROM invoice_items WHERE invoice_id = v_cur_inv AND task_id = NEW.id;
          v_affected_inv := v_cur_inv;
        END IF;
      END IF;

    -- Otherwise only reconcile lines for tasks that ARE billable
    ELSIF v_new_billable THEN
      v_new_period := DATE_TRUNC('month', COALESCE(NEW.task_date, CURRENT_DATE))::DATE;
      v_old_period := DATE_TRUNC('month', COALESCE(OLD.task_date, CURRENT_DATE))::DATE;

      SELECT i.id, i.status INTO v_cur_inv, v_cur_status
        FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
       WHERE ii.task_id = NEW.id
       LIMIT 1;

      IF (NEW.client_id IS DISTINCT FROM OLD.client_id OR v_new_period <> v_old_period)
         AND NEW.client_id IS NOT NULL
         AND v_cur_inv IS NOT NULL
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
           SET description = NEW.title,
               quantity    = COALESCE(NEW.quantity, 1),
               unit_price  = COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
               total       = COALESCE(NEW.billing_amount, NEW.billing_amount_inr, 0),
               currency    = COALESCE(NEW.currency, 'INR')
         WHERE task_id = NEW.id;
        SELECT invoice_id INTO v_affected_inv FROM invoice_items WHERE task_id = NEW.id LIMIT 1;
      END IF;
    END IF;
  END IF;

  PERFORM recalc_invoice_totals(v_affected_inv);
  RETURN NEW;
END;
$$;

COMMIT;
