-- Fix for Auto Draft issue date and sequence generation
-- Previously, it used the task's billing period (e.g. Jan 1) as the issue date.
-- Now, it will use the 1st of the next month (e.g. Feb 1) to align with Batch Generate.

CREATE OR REPLACE FUNCTION auto_attach_task_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_billing_period  DATE;
  v_issue_date      DATE;
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
                          
    -- 2. Issue date is the 1st of the NEXT month
    v_issue_date := (v_billing_period + INTERVAL '1 month')::DATE;

    -- 3. Fetch short client code for invoice number generation
    SELECT code
      INTO v_client_code
      FROM clients
     WHERE id = NEW.client_id;

    -- 4. Look for an existing draft invoice in that billing period
    SELECT id
      INTO v_invoice_id
      FROM invoices
     WHERE client_id          = NEW.client_id
       AND status             = 'draft'
       AND billing_period_start = v_billing_period
     LIMIT 1;

    -- 5. No draft found — create one
    IF v_invoice_id IS NULL THEN

      -- Build the base invoice number: INV-YYMM-CLIENTCODE
      -- Use the issue_date's YYMM to match the Batch Generate sequence
      v_base_inv_number := 'INV-'
                        || TO_CHAR(v_issue_date, 'YYMM')
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
        updated_at,
        invoice_sequence_month -- Store sequence month correctly
      )
      VALUES (
        v_inv_number,
        NEW.client_id,
        v_issue_date,                                                      -- issue_date (1st of next month)
        v_billing_period,                                                  -- billing_period_start
        (v_billing_period + INTERVAL '1 month' - INTERVAL '1 day')::DATE,  -- billing_period_end
        'draft',
        0,
        0,
        0,
        0,
        0,
        0,
        COALESCE(NEW.currency, 'INR'),
        'system',
        NOW(),
        NOW(),
        TO_CHAR(v_issue_date, 'YYMM')
      )
      RETURNING id INTO v_invoice_id;

    END IF;

    -- 6. Find the max display_order for existing line items
    SELECT COALESCE(MAX(display_order), -1)
      INTO v_display_order
      FROM invoice_items
     WHERE invoice_id = v_invoice_id;

    -- 7. Add this task as a line item
    INSERT INTO invoice_items (
      invoice_id,
      task_id,
      description,
      quantity,
      unit_price,
      total,
      currency,
      display_order
    )
    VALUES (
      v_invoice_id,
      NEW.id,
      NEW.title,
      COALESCE(NEW.quantity, 1),
      COALESCE(NEW.billing_amount_inr, 0),
      COALESCE(NEW.billing_amount_inr, 0),
      COALESCE(NEW.currency, 'INR'),
      v_display_order + 1
    )
    ON CONFLICT (invoice_id, task_id) DO UPDATE SET
      description = EXCLUDED.description,
      quantity    = EXCLUDED.quantity,
      unit_price  = EXCLUDED.unit_price,
      total       = EXCLUDED.total,
      currency    = EXCLUDED.currency;

    v_affected_inv := v_invoice_id;

  -- -------------------------------------------------------------------------
  -- CASE B: Task moves OUT of 'done' (cancelled, pending, in_progress, etc)
  -- -------------------------------------------------------------------------
  ELSIF (NEW.status != 'done' AND OLD.status = 'done')
        OR (TG_OP = 'DELETE' AND OLD.status = 'done')
  THEN

    -- 1. Find the invoice this task is attached to (only if draft/reviewed)
    SELECT i.id
      INTO v_invoice_id
      FROM invoices i
      JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE ii.task_id = OLD.id
       AND i.status IN ('draft', 'reviewed')
     LIMIT 1;

    IF v_invoice_id IS NOT NULL THEN
      -- 2. Remove the line item
      DELETE FROM invoice_items
       WHERE invoice_id = v_invoice_id
         AND task_id    = OLD.id;

      v_affected_inv := v_invoice_id;
    END IF;

  -- -------------------------------------------------------------------------
  -- CASE C: Task is already 'done', but its billing_amount changed
  -- -------------------------------------------------------------------------
  ELSIF NEW.status = 'done' AND OLD.status = 'done' THEN
    IF NEW.billing_amount_inr IS DISTINCT FROM OLD.billing_amount_inr
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
    THEN

      -- 1. Update the line item directly
      UPDATE invoice_items
         SET description = NEW.title,
             quantity    = COALESCE(NEW.quantity, 1),
             unit_price  = COALESCE(NEW.billing_amount_inr, 0),
             total       = COALESCE(NEW.billing_amount_inr, 0),
             currency    = COALESCE(NEW.currency, 'INR')
       WHERE task_id     = NEW.id;

      -- 2. Find which invoice was affected
      SELECT invoice_id
        INTO v_affected_inv
        FROM invoice_items
       WHERE task_id = NEW.id
       LIMIT 1;

    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- Finally: Recalculate totals for the affected invoice
  -- -------------------------------------------------------------------------
  IF v_affected_inv IS NOT NULL THEN
    UPDATE invoices
       SET subtotal     = (SELECT COALESCE(SUM(total), 0) FROM invoice_items WHERE invoice_id = v_affected_inv),
           total_amount = (SELECT COALESCE(SUM(total), 0) FROM invoice_items WHERE invoice_id = v_affected_inv)
                          + tax_amount
                          - discount_amount
     WHERE id = v_affected_inv;
  END IF;

  RETURN NEW;
END;
$$;
