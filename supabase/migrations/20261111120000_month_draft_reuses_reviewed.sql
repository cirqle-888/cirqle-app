-- One open invoice per client per month: reuse a Reviewed one, never start "-2".
--
-- find_or_create_client_month_draft() only reused an invoice whose status was
-- exactly 'draft'. When a task was finished while that month's invoice sat in
-- Reviewed, it created a second draft (INV-YYMM-CODE-2) and put the task
-- there. Resync on the real invoice then saw the task as already invoiced and
-- left it on the duplicate, so the work never reached the invoice being sent.
-- Seen on INV-2612-061 (task #2141 went to INV-2612-061-2).
--
-- Now: reuse the month's draft, else its Reviewed invoice — oldest first, so the
-- base number wins over any old duplicate. A Reviewed invoice that gets a new
-- line goes back to Draft: it changed after someone checked it, so it should
-- be checked again before it is sent.
--
-- Only once the month's invoice has been SENT does a new task still start a
-- fresh "-2" draft — that is a genuine supplementary invoice.
--
-- Body otherwise identical to 20260701120000_billing_sync_hardening.sql.

BEGIN;

CREATE OR REPLACE FUNCTION find_or_create_client_month_draft(
  p_client_id     UUID,
  p_period        DATE,
  p_currency      TEXT,
  p_exchange_rate NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_id  UUID;
  v_status      TEXT;
  v_issue_date  DATE;
  v_client_code TEXT;
  v_base_number TEXT;
  v_number      TEXT;
  v_counter     INT;
BEGIN
  -- Existing not-yet-sent invoice for this client + billing month?
  SELECT id, status INTO v_invoice_id, v_status
    FROM invoices
   WHERE client_id            = p_client_id
     AND status               IN ('draft', 'reviewed')
     AND billing_period_start = p_period
   ORDER BY (status = 'draft') DESC, created_at ASC
   LIMIT 1;

  IF v_invoice_id IS NOT NULL THEN
    IF v_status = 'reviewed' THEN
      UPDATE invoices SET status = 'draft', updated_at = NOW() WHERE id = v_invoice_id;
    END IF;
    RETURN v_invoice_id;
  END IF;

  -- Issue date = 1st of the next month (same convention as the original trigger)
  v_issue_date := (p_period + INTERVAL '1 month')::DATE;

  SELECT code INTO v_client_code FROM clients WHERE id = p_client_id;

  v_base_number := 'INV-' || TO_CHAR(v_issue_date, 'YYMM') || '-' || COALESCE(v_client_code, 'CLI');
  v_number      := v_base_number;
  v_counter     := 1;
  LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE invoice_number = v_number);
    v_counter := v_counter + 1;
    v_number  := v_base_number || '-' || v_counter::TEXT;
  END LOOP;

  INSERT INTO invoices (
    invoice_number, client_id, issue_date, billing_period_start, billing_period_end,
    status, total_amount, paid_amount, subtotal, tax_rate, tax_amount, discount_amount,
    currency, exchange_rate, created_by, created_at, updated_at, invoice_sequence_month
  ) VALUES (
    v_number, p_client_id, v_issue_date, p_period,
    (p_period + INTERVAL '1 month' - INTERVAL '1 day')::DATE,
    'draft', 0, 0, 0, 0, 0, 0,
    COALESCE(p_currency, 'INR'), COALESCE(p_exchange_rate, 1),
    NULL, NOW(), NOW(), TO_CHAR(v_issue_date, 'YYMM')
  )
  RETURNING id INTO v_invoice_id;

  RETURN v_invoice_id;
END;
$$;

COMMIT;
