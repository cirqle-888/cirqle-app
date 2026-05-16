-- ═══════════════════════════════════════════════════════════════════════════
-- BILLING CYCLE MIGRATION
-- Run this in Supabase SQL Editor (after invoice_automation_migration.sql)
--
-- What this does:
--   1. Adds billing_cycle + billing_day columns to clients
--   2. Replaces auto_attach_task_to_invoice() trigger to respect client cycle
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── SECTION 1 — Add billing cycle columns to clients ────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT DEFAULT 'monthly'
    CHECK (billing_cycle IN ('daily', 'weekly', 'monthly', 'none')),
  ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 1;
  -- billing_day usage:
  --   monthly: day of month to issue invoice (1-28), informational only
  --   weekly : day of week invoice is due (0=Sun … 6=Sat), informational only
  --   daily  : not used
  --   none   : no auto-invoice generation

COMMENT ON COLUMN clients.billing_cycle IS 'How often invoices are auto-generated: daily | weekly | monthly | none';
COMMENT ON COLUMN clients.billing_day   IS 'For monthly: day of month (1-28). For weekly: day of week (0-6).';


-- ─── SECTION 2 — Replace auto_attach_task_to_invoice() ───────────────────────
-- This version uses client.billing_cycle to determine the invoice period:
--   monthly  → groups tasks by calendar month  (INV-YYMM-CODE)
--   weekly   → groups tasks by ISO week        (INV-YYMMDD-CODE, week start)
--   daily    → one invoice per day             (INV-YYMMDD-CODE)
--   none     → skips auto-creation entirely

CREATE OR REPLACE FUNCTION auto_attach_task_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_billing_cycle   TEXT;
  v_billing_period  DATE;
  v_period_end      DATE;
  v_invoice_id      UUID;
  v_invoice_number  TEXT;
  v_base_number     TEXT;
  v_client_code     TEXT;
  v_existing_count  INT;
  v_suffix          INT;
  v_item_exists     BOOLEAN;
  v_item_total      DECIMAL(12,2);
  v_display_order   INT;
  v_task_desc       TEXT;
BEGIN

  -- ── CASE A: task just became 'done' ────────────────────────────────────────
  IF (NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status <> 'done')) THEN

    -- Skip if no client or no billing amount
    IF NEW.client_id IS NULL OR COALESCE(NEW.billing_amount_inr, 0) <= 0 THEN
      RETURN NEW;
    END IF;

    -- Get client billing cycle and code
    SELECT c.billing_cycle, c.code
    INTO   v_billing_cycle, v_client_code
    FROM   clients c
    WHERE  c.id = NEW.client_id;

    -- Honour "none" → no auto-invoice
    IF v_billing_cycle = 'none' OR v_billing_cycle IS NULL THEN
      RETURN NEW;
    END IF;

    -- ── Calculate billing period ───────────────────────────────────────────
    CASE v_billing_cycle
      WHEN 'monthly' THEN
        v_billing_period := DATE_TRUNC('month', COALESCE(NEW.task_date, CURRENT_DATE));
        v_period_end     := v_billing_period + INTERVAL '1 month' - INTERVAL '1 day';

      WHEN 'weekly' THEN
        -- Monday of the ISO week
        v_billing_period := DATE_TRUNC('week', COALESCE(NEW.task_date, CURRENT_DATE));
        v_period_end     := v_billing_period + INTERVAL '6 days';

      WHEN 'daily' THEN
        v_billing_period := COALESCE(NEW.task_date, CURRENT_DATE);
        v_period_end     := v_billing_period;

      ELSE
        -- fallback: monthly
        v_billing_period := DATE_TRUNC('month', COALESCE(NEW.task_date, CURRENT_DATE));
        v_period_end     := v_billing_period + INTERVAL '1 month' - INTERVAL '1 day';
    END CASE;

    -- ── Find or create draft invoice ───────────────────────────────────────
    SELECT id INTO v_invoice_id
    FROM   invoices
    WHERE  client_id           = NEW.client_id
      AND  billing_period_start = v_billing_period
      AND  status              = 'draft'
    LIMIT  1;

    IF v_invoice_id IS NULL THEN
      -- Build invoice number based on cycle
      CASE v_billing_cycle
        WHEN 'monthly' THEN
          v_base_number := 'INV-'
            || TO_CHAR(v_billing_period, 'YYMM')
            || '-' || COALESCE(v_client_code, 'CLI');
        WHEN 'weekly' THEN
          v_base_number := 'INV-'
            || TO_CHAR(v_billing_period, 'YYMMDD')
            || 'W-' || COALESCE(v_client_code, 'CLI');
        WHEN 'daily' THEN
          v_base_number := 'INV-'
            || TO_CHAR(v_billing_period, 'YYMMDD')
            || '-' || COALESCE(v_client_code, 'CLI');
        ELSE
          v_base_number := 'INV-'
            || TO_CHAR(v_billing_period, 'YYMM')
            || '-' || COALESCE(v_client_code, 'CLI');
      END CASE;

      -- Ensure uniqueness with -2, -3 … suffix
      v_invoice_number := v_base_number;
      v_suffix := 2;
      LOOP
        SELECT COUNT(*) INTO v_existing_count
        FROM   invoices
        WHERE  invoice_number = v_invoice_number;
        EXIT WHEN v_existing_count = 0;
        v_invoice_number := v_base_number || '-' || v_suffix;
        v_suffix := v_suffix + 1;
      END LOOP;

      INSERT INTO invoices (
        invoice_number, client_id, status,
        issue_date, billing_period_start, billing_period_end,
        currency, subtotal, tax_rate, tax_amount,
        discount_amount, previous_balance, total_amount, paid_amount
      )
      SELECT
        v_invoice_number,
        NEW.client_id,
        'draft',
        CURRENT_DATE,
        v_billing_period,
        v_period_end,
        COALESCE(c.default_currency, 'INR'),
        0, 0, 0, 0, 0, 0, 0
      FROM clients c
      WHERE c.id = NEW.client_id
      RETURNING id INTO v_invoice_id;
    END IF;

    -- ── Insert line item (idempotent) ──────────────────────────────────────
    SELECT EXISTS (
      SELECT 1 FROM invoice_items
      WHERE invoice_id = v_invoice_id AND task_id = NEW.id
    ) INTO v_item_exists;

    IF NOT v_item_exists THEN
      v_item_total := COALESCE(NEW.billing_amount_inr, 0);
      v_task_desc  := COALESCE(NEW.title, 'Task');

      SELECT COALESCE(MAX(display_order), -1) + 1
      INTO   v_display_order
      FROM   invoice_items
      WHERE  invoice_id = v_invoice_id;

      INSERT INTO invoice_items (
        invoice_id, task_id, description,
        quantity, unit_price, total,
        currency, display_order
      ) VALUES (
        v_invoice_id, NEW.id, v_task_desc,
        1, v_item_total, v_item_total,
        COALESCE(NEW.currency, 'INR'), v_display_order
      );

      PERFORM recalculate_invoice(v_invoice_id);
    END IF;

  -- ── CASE B: task cancelled → remove from open invoices ─────────────────
  ELSIF NEW.status = 'cancelled' AND OLD.status = 'done' THEN

    FOR v_invoice_id IN
      SELECT DISTINCT ii.invoice_id
      FROM   invoice_items ii
      JOIN   invoices inv ON inv.id = ii.invoice_id
      WHERE  ii.task_id = NEW.id
        AND  inv.client_id = NEW.client_id
        AND  inv.status IN ('draft', 'reviewed')
    LOOP
      DELETE FROM invoice_items WHERE task_id = NEW.id AND invoice_id = v_invoice_id;
      PERFORM recalculate_invoice(v_invoice_id);
    END LOOP;

  -- ── CASE C: billing amount changed while still done ─────────────────────
  ELSIF NEW.status = 'done' AND OLD.status = 'done'
    AND NEW.billing_amount_inr IS DISTINCT FROM OLD.billing_amount_inr THEN

    UPDATE invoice_items ii
    SET    unit_price = NEW.billing_amount_inr,
           total      = NEW.billing_amount_inr * ii.quantity
    FROM   invoices inv
    WHERE  ii.invoice_id = inv.id
      AND  ii.task_id    = NEW.id
      AND  inv.client_id = NEW.client_id
      AND  inv.status   IN ('draft', 'reviewed');

    FOR v_invoice_id IN
      SELECT DISTINCT ii.invoice_id
      FROM   invoice_items ii
      JOIN   invoices inv ON inv.id = ii.invoice_id
      WHERE  ii.task_id = NEW.id AND inv.status IN ('draft', 'reviewed')
    LOOP
      PERFORM recalculate_invoice(v_invoice_id);
    END LOOP;

  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION auto_attach_task_to_invoice() IS
  'Auto-creates/updates draft invoices when tasks change status. Respects client billing_cycle (daily/weekly/monthly/none).';

-- Re-install the trigger (idempotent)
DROP TRIGGER IF EXISTS trg_auto_attach_task ON tasks;
CREATE TRIGGER trg_auto_attach_task
  AFTER INSERT OR UPDATE OF status, billing_amount_inr
  ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION auto_attach_task_to_invoice();
