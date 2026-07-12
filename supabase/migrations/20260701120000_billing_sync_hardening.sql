-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Billing sync hardening                                                    ║
-- ║                                                                            ║
-- ║  Goals (all money-critical, all mutate ONLY draft/reviewed invoices):     ║
-- ║   1. Fix a latent bug: the task trigger recalculated invoice totals from   ║
-- ║      invoice_items ONLY, silently dropping invoice_expense_items and       ║
-- ║      previous_balance from the total whenever a task changed.              ║
-- ║   2. Auto-attach client-tagged cashbook OUTFLOWS to that client's monthly  ║
-- ║      draft (creating the draft if none exists) — mirroring how a task      ║
-- ║      hitting 'done' auto-attaches. So ad-spend etc. is never forgotten.    ║
-- ║   3. Harden the task trigger so a done task's client / billing-month /     ║
-- ║      currency change MOVES & re-stamps its invoice line.                   ║
-- ║                                                                            ║
-- ║  Shared helpers keep the task path and the expense path from diverging or  ║
-- ║  creating duplicate monthly drafts.                                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Correct, shared totals recalculation
--    subtotal     = Σ task line totals + Σ expense line amounts
--    total_amount = subtotal − discount + tax + previous_balance
--    (matches add-expense-modal.tsx:recalculateInvoiceTotal — the source of truth)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recalc_invoice_totals(p_invoice_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_task_total NUMERIC(14,2);
  v_exp_total  NUMERIC(14,2);
  v_subtotal   NUMERIC(14,2);
BEGIN
  IF p_invoice_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(total), 0)  INTO v_task_total FROM invoice_items         WHERE invoice_id = p_invoice_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_exp_total  FROM invoice_expense_items WHERE invoice_id = p_invoice_id;

  v_subtotal := v_task_total + v_exp_total;

  UPDATE invoices
     SET subtotal     = v_subtotal,
         total_amount = v_subtotal
                        - COALESCE(discount_amount, 0)
                        + COALESCE(tax_amount, 0)
                        + COALESCE(previous_balance, 0),
         updated_at   = NOW()
   WHERE id = p_invoice_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Find (or create) the per-client, per-month DRAFT invoice.
--    Single source of truth for the monthly draft + invoice-number generation,
--    shared by the task trigger and the expense trigger so they never create
--    two competing drafts for the same client-month.
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_issue_date  DATE;
  v_client_code TEXT;
  v_base_number TEXT;
  v_number      TEXT;
  v_counter     INT;
BEGIN
  -- Existing draft for this client + billing month?
  SELECT id INTO v_invoice_id
    FROM invoices
   WHERE client_id            = p_client_id
     AND status               = 'draft'
     AND billing_period_start = p_period
   LIMIT 1;

  IF v_invoice_id IS NOT NULL THEN
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
    NULL, NOW(), NOW(), TO_CHAR(v_issue_date, 'YYMM')  -- created_by: NULL for system-generated drafts (matches existing convention; 'system' is not a valid uuid)
  )
  RETURNING id INTO v_invoice_id;

  RETURN v_invoice_id;
END;
$$;

-- Helper: exchange rate for a currency (1 for INR / unknown)
CREATE OR REPLACE FUNCTION rate_to_inr_for(p_currency TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE v_rate NUMERIC(18,6);
BEGIN
  IF COALESCE(p_currency, 'INR') = 'INR' THEN RETURN 1; END IF;
  SELECT rate_to_inr INTO v_rate FROM exchange_rates WHERE currency = p_currency LIMIT 1;
  RETURN COALESCE(v_rate, 1);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Rewritten task → invoice trigger (uses the shared helpers + hardened CASE C)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_attach_task_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_billing_period DATE;
  v_invoice_id     UUID;
  v_display_order  INT;
  v_affected_inv   UUID;
  v_exchange_rate  NUMERIC(18,6);
  -- CASE C helpers
  v_new_period     DATE;
  v_old_period     DATE;
  v_cur_inv        UUID;
  v_cur_status     TEXT;
  v_moved          BOOLEAN := FALSE;
BEGIN

  -- ── CASE A: task reaches 'done' for the first time ────────────────────────
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

  -- ── CASE B: task leaves 'done' (or a done task is deleted) ─────────────────
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

  -- ── CASE C: task stays 'done' but something changed ───────────────────────
  ELSIF NEW.status = 'done' AND OLD.status = 'done' THEN
    v_new_period := DATE_TRUNC('month', COALESCE(NEW.task_date, CURRENT_DATE))::DATE;
    v_old_period := DATE_TRUNC('month', COALESCE(OLD.task_date, CURRENT_DATE))::DATE;

    -- Where does the line currently live?
    SELECT i.id, i.status INTO v_cur_inv, v_cur_status
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE ii.task_id = NEW.id
     LIMIT 1;

    -- Client or billing-month changed → MOVE the line (only off draft/reviewed)
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

    -- Otherwise: in-place update if amount / title / qty / currency changed
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

  -- Recalculate totals for the affected invoice (correct formula incl. expenses)
  PERFORM recalc_invoice_totals(v_affected_inv);

  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Expense → invoice trigger: client-tagged cashbook OUTFLOWS auto-attach to
--    that client's monthly draft (creating it if needed). Mirrors the task path.
--
--    Intent-safe: only ATTACHES on insert / becoming-billable transitions, so if
--    you manually remove an auto-billed expense from an invoice it stays removed.
--    Only ever touches draft/reviewed invoices; UNIQUE(cashbook_entry_id) already
--    guarantees "bill once".
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_attach_expense_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_period      DATE;
  v_rate        NUMERIC(18,6);
  v_invoice_id  UUID;
  v_inv_currency TEXT;
  v_item_inv    UUID;
  v_item_status TEXT;
  v_should_add  BOOLEAN;
BEGIN
  -- ── Detach path: entry removed / soft-deleted / untagged / flipped to inflow ─
  IF TG_OP = 'DELETE'
     OR NEW.deleted_at IS NOT NULL
     OR COALESCE(NEW.type, '') <> 'outflow'
     OR NEW.client_id IS NULL
  THEN
    SELECT ii.invoice_id, i.status INTO v_item_inv, v_item_status
      FROM invoice_expense_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.cashbook_entry_id = COALESCE(OLD.id, NEW.id)
     LIMIT 1;

    IF v_item_inv IS NOT NULL AND v_item_status IN ('draft', 'reviewed') THEN
      DELETE FROM invoice_expense_items WHERE cashbook_entry_id = COALESCE(OLD.id, NEW.id);
      PERFORM recalc_invoice_totals(v_item_inv);
    END IF;

    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Here: NEW is an active OUTFLOW tagged to a client.

  -- Already billed? Propagate edits onto a draft/reviewed line (keep markup);
  -- leave sent/paid invoices untouched; never re-add elsewhere.
  SELECT ii.invoice_id, i.status INTO v_item_inv, v_item_status
    FROM invoice_expense_items ii JOIN invoices i ON i.id = ii.invoice_id
   WHERE ii.cashbook_entry_id = NEW.id
   LIMIT 1;

  IF v_item_inv IS NOT NULL THEN
    IF v_item_status IN ('draft', 'reviewed') THEN
      UPDATE invoice_expense_items
         SET description         = COALESCE(NULLIF(NEW.description, ''), description),
             original_amount     = NEW.amount,
             original_amount_inr = NEW.amount_inr,
             amount              = NEW.amount     + COALESCE(markup_amount, 0),
             amount_inr          = NEW.amount_inr + COALESCE(markup_amount, 0) * rate_to_inr_for(NEW.currency),
             currency            = COALESCE(NEW.currency, 'INR')
       WHERE cashbook_entry_id = NEW.id;
      PERFORM recalc_invoice_totals(v_item_inv);
    END IF;
    RETURN NEW;
  END IF;

  -- Not billed yet. Only auto-attach on INSERT or a becoming-billable transition,
  -- so a manual removal is respected (a plain edit won't re-add it).
  v_should_add := (TG_OP = 'INSERT')
     OR (TG_OP = 'UPDATE' AND (
            (OLD.client_id IS NULL AND NEW.client_id IS NOT NULL)
         OR (COALESCE(OLD.type, '') <> 'outflow' AND NEW.type = 'outflow')
         OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
        ));

  IF NOT v_should_add THEN
    RETURN NEW;
  END IF;

  v_period     := DATE_TRUNC('month', COALESCE(NEW.entry_date, CURRENT_DATE))::DATE;
  v_rate       := rate_to_inr_for(NEW.currency);
  v_invoice_id := find_or_create_client_month_draft(NEW.client_id, v_period, NEW.currency, v_rate);

  -- Currency guard: only auto-attach when the draft's currency matches the entry
  -- (avoids introducing an FX conversion automatically — the badge surfaces the rest).
  SELECT COALESCE(currency, 'INR') INTO v_inv_currency FROM invoices WHERE id = v_invoice_id;
  IF v_inv_currency <> COALESCE(NEW.currency, 'INR') THEN
    RETURN NEW;
  END IF;

  INSERT INTO invoice_expense_items (
    invoice_id, cashbook_entry_id, description, amount, amount_inr, currency,
    original_amount, original_amount_inr, markup_type, markup_value, markup_amount
  ) VALUES (
    v_invoice_id, NEW.id, COALESCE(NULLIF(NEW.description, ''), 'Expense'),
    NEW.amount, NEW.amount_inr, COALESCE(NEW.currency, 'INR'),
    NEW.amount, NEW.amount_inr, 'none', 0, 0
  )
  ON CONFLICT (cashbook_entry_id) DO NOTHING;

  PERFORM recalc_invoice_totals(v_invoice_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_attach_expense ON cashbook_entries;
CREATE OR REPLACE TRIGGER trg_auto_attach_expense
  AFTER INSERT OR UPDATE OR DELETE ON cashbook_entries
  FOR EACH ROW EXECUTE FUNCTION auto_attach_expense_to_invoice();

COMMIT;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ONE-TIME BACKFILL — run MANUALLY after reviewing the dry-run.             ║
-- ║  (Not executed by this migration.)                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- STEP 1 — DRY RUN: preview every client-tagged outflow that is NOT yet billed,
-- and the client-month draft it would attach to. Review before applying.
--
--   SELECT ce.id, ce.entry_date, ce.description, ce.amount, ce.currency,
--          c.name AS client, DATE_TRUNC('month', ce.entry_date)::date AS bill_month
--     FROM cashbook_entries ce
--     JOIN clients c ON c.id = ce.client_id
--    WHERE ce.type = 'outflow'
--      AND ce.client_id IS NOT NULL
--      AND ce.deleted_at IS NULL
--      AND NOT EXISTS (SELECT 1 FROM invoice_expense_items ii WHERE ii.cashbook_entry_id = ce.id)
--    ORDER BY c.name, ce.entry_date;
--
-- STEP 2 — APPLY: attach each of the above to its client-month draft (creating
-- drafts as needed) using the exact same logic as the live trigger.
--
--   DO $backfill$
--   DECLARE r RECORD; v_inv UUID; v_cur TEXT;
--   BEGIN
--     FOR r IN
--       SELECT ce.* FROM cashbook_entries ce
--        WHERE ce.type = 'outflow' AND ce.client_id IS NOT NULL AND ce.deleted_at IS NULL
--          AND NOT EXISTS (SELECT 1 FROM invoice_expense_items ii WHERE ii.cashbook_entry_id = ce.id)
--     LOOP
--       v_inv := find_or_create_client_month_draft(
--                  r.client_id,
--                  DATE_TRUNC('month', COALESCE(r.entry_date, CURRENT_DATE))::date,
--                  r.currency, rate_to_inr_for(r.currency));
--       SELECT COALESCE(currency,'INR') INTO v_cur FROM invoices WHERE id = v_inv;
--       IF v_cur = COALESCE(r.currency,'INR') THEN
--         INSERT INTO invoice_expense_items (
--           invoice_id, cashbook_entry_id, description, amount, amount_inr, currency,
--           original_amount, original_amount_inr, markup_type, markup_value, markup_amount)
--         VALUES (v_inv, r.id, COALESCE(NULLIF(r.description,''),'Expense'),
--           r.amount, r.amount_inr, COALESCE(r.currency,'INR'),
--           r.amount, r.amount_inr, 'none', 0, 0)
--         ON CONFLICT (cashbook_entry_id) DO NOTHING;
--         PERFORM recalc_invoice_totals(v_inv);
--       END IF;
--     END LOOP;
--   END
--   $backfill$;
--
-- ── (Optional) Backfill ORPHAN done tasks — 'done' tasks with billing that are  ─
-- on NO invoice line (e.g. marked done before the trigger existed). Conservative:
-- status='done' only; 'invoiced' tasks with no line are anomalies — review by hand.
--
-- STEP 3 — DRY RUN:
--   SELECT t.task_number, t.title, c.name AS client, t.task_date,
--          COALESCE(t.billing_amount, t.billing_amount_inr) AS billing
--     FROM tasks t JOIN clients c ON c.id = t.client_id
--    WHERE t.deleted_at IS NULL AND t.status = 'done' AND t.client_id IS NOT NULL
--      AND COALESCE(t.billing_amount, t.billing_amount_inr, 0) > 0
--      AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.task_id = t.id)
--    ORDER BY c.name, t.task_date;
--
-- STEP 4 — APPLY:
--   DO $taskfill$
--   DECLARE r RECORD; v_inv UUID; v_ord INT;
--   BEGIN
--     FOR r IN
--       SELECT t.* FROM tasks t
--        WHERE t.deleted_at IS NULL AND t.status = 'done' AND t.client_id IS NOT NULL
--          AND COALESCE(t.billing_amount, t.billing_amount_inr, 0) > 0
--          AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.task_id = t.id)
--     LOOP
--       v_inv := find_or_create_client_month_draft(
--                  r.client_id,
--                  DATE_TRUNC('month', COALESCE(r.task_date, CURRENT_DATE))::date,
--                  r.currency, rate_to_inr_for(r.currency));
--       SELECT COALESCE(MAX(display_order), -1) INTO v_ord FROM invoice_items WHERE invoice_id = v_inv;
--       INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, total, currency, display_order)
--       VALUES (v_inv, r.id, r.title, COALESCE(r.quantity, 1),
--         COALESCE(r.billing_amount, r.billing_amount_inr, 0),
--         COALESCE(r.billing_amount, r.billing_amount_inr, 0),
--         COALESCE(r.currency, 'INR'), v_ord + 1)
--       ON CONFLICT (invoice_id, task_id) DO NOTHING;
--       PERFORM recalc_invoice_totals(v_inv);
--     END LOOP;
--   END
--   $taskfill$;
