-- =============================================================================
-- CIRQLE INVOICE AUTOMATION MIGRATION
-- =============================================================================
-- Purpose : Extend the invoices table with billing-period and tax fields,
--           widen the status constraint to include 'reviewed' and 'finalized',
--           and install a trigger-driven function that automatically attaches
--           completed tasks to a matching draft invoice (creating one when
--           none exists) and keeps invoice totals in sync.
--
-- Target  : Supabase / PostgreSQL (tested on PG 15+)
-- Run via : Supabase SQL editor, psql, or a migration tool (e.g. Flyway).
--           The script is idempotent — safe to re-run on an already-migrated
--           database with no harmful side-effects.
--
-- Sections:
--   1. invoices   — add billing-period + tax columns
--   2. invoices   — widen status CHECK constraint
--   3. Function   — recalculate_invoice(p_invoice_id)
--   4. Function   — auto_attach_task_to_invoice()
--   5. Trigger    — task_auto_invoice ON tasks
-- =============================================================================


-- =============================================================================
-- SECTION 1 — Add new columns to invoices
-- =============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS billing_period_start  DATE,
  ADD COLUMN IF NOT EXISTS billing_period_end    DATE,
  ADD COLUMN IF NOT EXISTS subtotal              DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate              DECIMAL(5,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount            DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount       DECIMAL(12,2) DEFAULT 0;

COMMENT ON COLUMN invoices.billing_period_start IS
  'First day of the billing period this invoice covers (usually 1st of month).';
COMMENT ON COLUMN invoices.billing_period_end IS
  'Last day of the billing period this invoice covers (usually last day of month).';
COMMENT ON COLUMN invoices.subtotal IS
  'Sum of all invoice_items.total before tax and discounts.';
COMMENT ON COLUMN invoices.tax_rate IS
  'GST / tax rate percentage, e.g. 18.00 for 18 %.';
COMMENT ON COLUMN invoices.tax_amount IS
  'Computed as subtotal * tax_rate / 100.';
COMMENT ON COLUMN invoices.discount_amount IS
  'Flat discount applied after tax.';


-- =============================================================================
-- SECTION 2 — Widen the invoices.status CHECK constraint
--
-- PostgreSQL does not support ALTER CONSTRAINT; the only safe path is to
-- drop the old constraint by name and recreate it.  We first discover the
-- constraint name dynamically so the script works even if the constraint was
-- created with a generated name.
-- =============================================================================

DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  -- Find the current CHECK constraint on invoices.status
  SELECT conname
    INTO v_constraint_name
    FROM pg_constraint
    JOIN pg_class ON pg_class.oid = pg_constraint.conrelid
   WHERE pg_class.relname  = 'invoices'
     AND pg_constraint.contype = 'c'
     AND pg_get_constraintdef(pg_constraint.oid) LIKE '%status%'
   LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', v_constraint_name);
    RAISE NOTICE 'Dropped old status constraint: %', v_constraint_name;
  ELSE
    RAISE NOTICE 'No existing status CHECK constraint found on invoices — skipping drop.';
  END IF;
END;
$$;

-- Add the widened constraint with 'reviewed' and 'finalized' included
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
    CHECK (status IN (
      'draft',
      'reviewed',
      'finalized',
      'sent',
      'partial',
      'paid',
      'overdue',
      'cancelled',
      'bad_debt'
    ));


-- =============================================================================
-- SECTION 3 — Helper: recalculate_invoice(p_invoice_id UUID)
--
-- Recomputes subtotal, tax_amount, and total_amount for a single invoice
-- from the live invoice_items rows.  Call this any time items change.
-- =============================================================================

CREATE OR REPLACE FUNCTION recalculate_invoice(p_invoice_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_subtotal         DECIMAL(12,2);
  v_tax_rate         DECIMAL(5,2);
  v_tax_amount       DECIMAL(12,2);
  v_discount_amount  DECIMAL(12,2);
  v_total_amount     DECIMAL(12,2);
BEGIN
  -- Pull current tax_rate and discount_amount from the invoice header
  SELECT COALESCE(tax_rate, 0), COALESCE(discount_amount, 0)
    INTO v_tax_rate, v_discount_amount
    FROM invoices
   WHERE id = p_invoice_id;

  -- Sum all line items
  SELECT COALESCE(SUM(total), 0)
    INTO v_subtotal
    FROM invoice_items
   WHERE invoice_id = p_invoice_id;

  v_tax_amount   := ROUND(v_subtotal * v_tax_rate / 100, 2);
  v_total_amount := v_subtotal + v_tax_amount - v_discount_amount;

  UPDATE invoices
     SET subtotal         = v_subtotal,
         tax_amount       = v_tax_amount,
         total_amount     = v_total_amount,
         updated_at       = NOW()
   WHERE id = p_invoice_id;
END;
$$;

COMMENT ON FUNCTION recalculate_invoice(UUID) IS
  'Recomputes subtotal, tax_amount, and total_amount for the given invoice '
  'from live invoice_items rows.  Idempotent — safe to call multiple times.';


-- =============================================================================
-- SECTION 4 — Trigger function: auto_attach_task_to_invoice()
--
-- Fires AFTER INSERT OR UPDATE OF status, billing_amount_inr ON tasks.
--
-- Behaviour:
--   • task → 'done'        : find or create a draft invoice for the task's
--                            client + billing month, attach a line item, and
--                            recalculate the invoice total.
--   • task → 'cancelled'   : remove the line item from any draft/reviewed
--                            invoice and recalculate.
--   • billing_amount_inr changes while task is already 'done':
--                            update the existing line item and recalculate.
-- =============================================================================

CREATE OR REPLACE FUNCTION auto_attach_task_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_billing_period  DATE;
  v_client_code     TEXT;
  v_invoice_id      UUID;
  v_base_inv_number TEXT;
  v_inv_number      TEXT;
  v_counter         INT;
  v_display_order   INT;
  v_affected_inv    UUID;
BEGIN

  -- -------------------------------------------------------------------------
  -- CASE A: Task moved to 'done' for the first time this session
  -- -------------------------------------------------------------------------
  IF NEW.status = 'done'
     AND (OLD.status IS NULL OR OLD.status != 'done')
     AND NEW.client_id IS NOT NULL
  THEN

    -- 1. Derive billing period (first day of the task's month)
    v_billing_period := DATE_TRUNC('month',
                          COALESCE(NEW.task_date, CURRENT_DATE))::DATE;

    -- 2. Fetch short client code for invoice number generation
    SELECT code
      INTO v_client_code
      FROM clients
     WHERE id = NEW.client_id;

    -- 3. Look for an existing draft invoice in that billing period
    SELECT id
      INTO v_invoice_id
      FROM invoices
     WHERE client_id          = NEW.client_id
       AND status             = 'draft'
       AND billing_period_start = v_billing_period
     LIMIT 1;

    -- 4. No draft found — create one
    IF v_invoice_id IS NULL THEN

      -- Build the base invoice number: INV-YYMM-CLIENTCODE
      v_base_inv_number := 'INV-'
                        || TO_CHAR(v_billing_period, 'YYMM')
                        || '-'
                        || COALESCE(v_client_code, 'CLI');

      v_inv_number := v_base_inv_number;
      v_counter    := 1;

      -- Increment suffix until we find a unique invoice number
      LOOP
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM invoices WHERE invoice_number = v_inv_number
        );
        v_counter    := v_counter + 1;
        v_inv_number := v_base_inv_number || '-' || v_counter::TEXT;
      END LOOP;

      INSERT INTO invoices (
        invoice_number,
        client_id,
        issue_date,
        billing_period_start,
        billing_period_end,
        status,
        total_amount,
        paid_amount,
        subtotal,
        tax_rate,
        tax_amount,
        discount_amount,
        currency,
        created_by,
        created_at,
        updated_at
      )
      VALUES (
        v_inv_number,
        NEW.client_id,
        v_billing_period,                                                  -- issue_date
        v_billing_period,                                                  -- billing_period_start
        (v_billing_period + INTERVAL '1 month' - INTERVAL '1 day')::DATE, -- billing_period_end
        'draft',
        0,
        0,
        0,
        0,
        0,
        0,
        COALESCE(NEW.currency, 'INR'),
        NEW.created_by,
        NOW(),
        NOW()
      )
      RETURNING id INTO v_invoice_id;

    END IF; -- end: no existing draft

    -- 5. Attach line item only if this task is not already on this invoice
    IF NOT EXISTS (
      SELECT 1
        FROM invoice_items
       WHERE task_id    = NEW.id
         AND invoice_id = v_invoice_id
    ) THEN

      -- Determine display order (append at the end)
      SELECT COALESCE(MAX(display_order), 0) + 1
        INTO v_display_order
        FROM invoice_items
       WHERE invoice_id = v_invoice_id;

      INSERT INTO invoice_items (
        invoice_id,
        task_id,
        description,
        service_id,
        quantity,
        unit_price,
        total,
        currency,
        display_order
      )
      VALUES (
        v_invoice_id,
        NEW.id,
        COALESCE(NEW.title, 'Task'),
        NEW.service_id,
        1,
        COALESCE(NEW.billing_amount_inr, 0),
        COALESCE(NEW.billing_amount_inr, 0),
        COALESCE(NEW.currency, 'INR'),
        v_display_order
      );

    END IF; -- end: task not already on invoice

    -- 6. Recalculate invoice totals
    PERFORM recalculate_invoice(v_invoice_id);

  -- -------------------------------------------------------------------------
  -- CASE B: Task cancelled — remove from any open (draft/reviewed) invoices
  -- -------------------------------------------------------------------------
  ELSIF NEW.status = 'cancelled'
        AND OLD.status IS DISTINCT FROM 'cancelled'
  THEN

    -- Remove line items for this task from open invoices
    DELETE FROM invoice_items
     WHERE task_id    = NEW.id
       AND invoice_id IN (
             SELECT id
               FROM invoices
              WHERE client_id = NEW.client_id
                AND status    IN ('draft', 'reviewed')
           );

    -- Recalculate every affected invoice
    FOR v_affected_inv IN
      SELECT DISTINCT i.id
        FROM invoices i
       WHERE i.client_id = NEW.client_id
         AND i.status    IN ('draft', 'reviewed')
    LOOP
      PERFORM recalculate_invoice(v_affected_inv);
    END LOOP;

  -- -------------------------------------------------------------------------
  -- CASE C: billing_amount_inr changed while task is still 'done'
  -- -------------------------------------------------------------------------
  ELSIF NEW.status = 'done'
        AND OLD.status = 'done'
        AND NEW.billing_amount_inr IS DISTINCT FROM OLD.billing_amount_inr
  THEN

    -- Update matching line items on open invoices
    UPDATE invoice_items
       SET unit_price  = COALESCE(NEW.billing_amount_inr, 0),
           total       = COALESCE(NEW.billing_amount_inr, 0)
     WHERE task_id    = NEW.id
       AND invoice_id IN (
             SELECT id
               FROM invoices
              WHERE status IN ('draft', 'reviewed')
           );

    -- Recalculate every affected invoice
    FOR v_affected_inv IN
      SELECT DISTINCT i.id
        FROM invoices       i
        JOIN invoice_items  ii ON ii.invoice_id = i.id
       WHERE ii.task_id = NEW.id
         AND i.status   IN ('draft', 'reviewed')
    LOOP
      PERFORM recalculate_invoice(v_affected_inv);
    END LOOP;

  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION auto_attach_task_to_invoice() IS
  'Trigger function that auto-manages invoice line items when a task status '
  'or billing amount changes.  Attach on AFTER INSERT OR UPDATE OF status, '
  'billing_amount_inr ON tasks.';


-- =============================================================================
-- SECTION 5 — Install the trigger on tasks
-- =============================================================================

DROP TRIGGER IF EXISTS task_auto_invoice ON tasks;

CREATE TRIGGER task_auto_invoice
  AFTER INSERT OR UPDATE OF status, billing_amount_inr
  ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION auto_attach_task_to_invoice();

COMMENT ON TRIGGER task_auto_invoice ON tasks IS
  'Automatically attaches completed tasks to a monthly draft invoice and '
  'keeps invoice totals recalculated in real time.';


-- =============================================================================
-- END OF MIGRATION
-- =============================================================================

-- =============================================================================
-- SECTION 6 — previous_balance field + company payment settings
-- =============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS previous_balance DECIMAL(12,2) DEFAULT 0;

COMMENT ON COLUMN invoices.previous_balance IS
  'Carried-forward outstanding balance from prior billing period.';

-- Ensure company_settings has payment info keys (INSERT IGNORE style)
INSERT INTO company_settings (key, value) VALUES
  ('bank_holder',  'Ummarul Farooq V V')   ON CONFLICT (key) DO NOTHING;
INSERT INTO company_settings (key, value) VALUES
  ('bank_account', '6050750513')            ON CONFLICT (key) DO NOTHING;
INSERT INTO company_settings (key, value) VALUES
  ('bank_ifsc',    'KKBK0008655')           ON CONFLICT (key) DO NOTHING;
INSERT INTO company_settings (key, value) VALUES
  ('bank_upi',     '8129534377@kotak811')   ON CONFLICT (key) DO NOTHING;
INSERT INTO company_settings (key, value) VALUES
  ('company_phone','8129534377')            ON CONFLICT (key) DO NOTHING;
INSERT INTO company_settings (key, value) VALUES
  ('company_website','www.cirqle.work')     ON CONFLICT (key) DO NOTHING;
INSERT INTO company_settings (key, value) VALUES
  ('company_tagline','Get Budget Designs')  ON CONFLICT (key) DO NOTHING;
