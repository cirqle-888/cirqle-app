-- ═══════════════════════════════════════════════════════════════════════════
-- AGREEMENT WORK VALUES — pay employees for retainer-covered work, and make
-- the agreement page the single pricing source for agreement clients.
--
-- Problem: a retainer-covered task deliberately bills the client 0 (the
-- monthly retainer is the invoice), but the contribution engine computes the
-- employee pool from tasks.billing_amount_inr — so every contributor earns 0
-- on covered work.
--
-- Model — three prices, all on client_agreement_items:
--   • unit_price            (existing) what the CLIENT pays per cycle → invoice
--   • work_unit_value       (NEW)      internal per-task value → contributions
--                                      only, never invoiced
--   • extra_unit_price      (existing) client price per task beyond the
--                                      committed quantity (bill_as_extra)
--   • work_commission_pct   (NEW)      employee-pool % for covered work;
--                                      NULL → the engine's default 50
--
-- tasks.work_value_inr is stamped by trigger (work_unit_value × quantity × fx)
-- whenever a task is covered and not billed as extra; NULL otherwise. The
-- contribution engine uses it as the pool basis for covered tasks — billing
-- stays 0, invoices stay agreement-based.
--
-- Also: monthly retainer fee auto-invoicing. ensure_retainer_invoice_lines()
-- inserts one line per active retainer item into the client-month draft
-- (idempotent), so the invoice is fully agreement-driven. Called by the
-- /api/cron/retainer-invoices cron on the 1st of each month.
--
-- ADDITIVE + idempotent. Rollback:
-- supabase/rollbacks/20260807110000_agreement_work_values_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Agreement item columns ────────────────────────────────────────────────
ALTER TABLE public.client_agreement_items
  ADD COLUMN IF NOT EXISTS work_unit_value     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS work_commission_pct NUMERIC(5,2);

COMMENT ON COLUMN public.client_agreement_items.work_unit_value IS
  'Internal per-task value (item currency) for covered work. Feeds the contribution pool only — never invoiced.';
COMMENT ON COLUMN public.client_agreement_items.work_commission_pct IS
  'Employee-pool % applied to work on this agreement item. NULL = engine default (50).';

-- One-off seed so existing agreements (e.g. Elara) pay out immediately:
-- prefer the explicit internal allocation unit value, else fee ÷ quantity.
UPDATE public.client_agreement_items
   SET work_unit_value = ROUND(
         COALESCE(
           allocated_unit_value,
           unit_price / NULLIF(COALESCE(included_quantity, committed_quantity), 0)
         )::numeric, 2)
 WHERE work_unit_value IS NULL
   AND COALESCE(allocated_unit_value,
                unit_price / NULLIF(COALESCE(included_quantity, committed_quantity), 0)) IS NOT NULL;

-- ── 2. Task work-value stamp ─────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS work_value_inr NUMERIC(12,2);

COMMENT ON COLUMN public.tasks.work_value_inr IS
  'Internal value (INR) of retainer-covered work: item.work_unit_value × quantity × fx. NULL unless covered and not bill_as_extra. Contribution pool basis; never billed.';

-- BEFORE trigger. Named so it fires AFTER trg_task_retainer_coverage
-- (alphabetical among BEFORE triggers: ..._retainer_coverage < ..._work_value)
-- and therefore sees the freshly detected retainer_item_id.
CREATE OR REPLACE FUNCTION public.set_task_work_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit NUMERIC(12,2);
  v_cur  TEXT;
BEGIN
  IF NEW.retainer_item_id IS NOT NULL AND NOT COALESCE(NEW.bill_as_extra, FALSE) THEN
    SELECT work_unit_value, currency INTO v_unit, v_cur
      FROM public.client_agreement_items WHERE id = NEW.retainer_item_id;
    IF v_unit IS NULL THEN
      NEW.work_value_inr := NULL;  -- no work value set on the agreement yet
    ELSE
      NEW.work_value_inr := ROUND(v_unit * COALESCE(NEW.quantity, 1) * rate_to_inr_for(v_cur), 2);
    END IF;
  ELSE
    NEW.work_value_inr := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_work_value ON public.tasks;
CREATE TRIGGER trg_task_work_value
  BEFORE INSERT OR UPDATE OF client_id, service_id, task_date, quantity, bill_as_extra, retainer_item_id
  ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_work_value();

-- Re-stamp every covered task of one agreement item (called after the item's
-- work_unit_value / currency changes). Returns the number of tasks updated.
CREATE OR REPLACE FUNCTION public.restamp_agreement_item_work_values(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.tasks t
     SET work_value_inr = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1) * rate_to_inr_for(i.currency), 2)
         END
    FROM public.client_agreement_items i
   WHERE i.id = p_item_id
     AND t.retainer_item_id = p_item_id
     AND NOT COALESCE(t.bill_as_extra, FALSE)
     AND t.deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- One-off backfill of every already-covered task.
UPDATE public.tasks t
   SET work_value_inr = CASE
         WHEN i.work_unit_value IS NULL THEN NULL
         ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1) * rate_to_inr_for(i.currency), 2)
       END
  FROM public.client_agreement_items i
 WHERE t.retainer_item_id = i.id
   AND NOT COALESCE(t.bill_as_extra, FALSE);

-- ── 3. Monthly retainer fee → invoice line ───────────────────────────────────
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS agreement_item_id UUID
    REFERENCES public.client_agreement_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.invoice_items.agreement_item_id IS
  'Set on auto-generated retainer-fee lines (task_id is NULL for those). One per invoice per item.';

CREATE UNIQUE INDEX IF NOT EXISTS invoice_items_agreement_item_uniq
  ON public.invoice_items (invoice_id, agreement_item_id)
  WHERE agreement_item_id IS NOT NULL;

-- Idempotent: for the given billing month, add one retainer-fee line per
-- active retainer term row into that client's month draft. A term row whose
-- agreement/service already has a fee line in ANY invoice of that month is
-- skipped (covers close-and-replace term changes and sent invoices).
CREATE OR REPLACE FUNCTION public.ensure_retainer_invoice_lines(p_period DATE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  r            RECORD;
  v_period     DATE := DATE_TRUNC('month', p_period)::DATE;
  v_period_end DATE := (DATE_TRUNC('month', p_period) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  v_inv        UUID;
  v_ord        INT;
  v_added      INTEGER := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (i.agreement_id, COALESCE(i.service_id::text, i.id::text))
           i.id AS item_id, i.agreement_id, i.service_id, i.unit_price, i.currency,
           a.client_id, COALESCE(s.name, a.title) AS line_label
      FROM public.client_agreement_items i
      JOIN public.client_agreements a ON a.id = i.agreement_id
      LEFT JOIN public.services s ON s.id = i.service_id
     WHERE a.status = 'active'
       AND a.deleted_at IS NULL
       AND i.commitment_type = 'retainer'
       AND COALESCE(i.unit_price, 0) > 0
       AND i.effective_from <= v_period_end
       AND (i.effective_to IS NULL OR i.effective_to >= v_period)
       AND a.start_date <= v_period_end
       AND (a.end_date IS NULL OR a.end_date >= v_period)
     ORDER BY i.agreement_id, COALESCE(i.service_id::text, i.id::text), i.effective_from DESC
  LOOP
    -- Already billed this month (same agreement + service, any term row, any invoice)?
    IF EXISTS (
      SELECT 1
        FROM public.invoice_items ii
        JOIN public.invoices inv ON inv.id = ii.invoice_id
       WHERE inv.billing_period_start = v_period
         AND ii.agreement_item_id IN (
           SELECT x.id FROM public.client_agreement_items x
            WHERE x.agreement_id = r.agreement_id
              AND x.service_id IS NOT DISTINCT FROM r.service_id)
    ) THEN
      CONTINUE;
    END IF;

    v_inv := find_or_create_client_month_draft(
      r.client_id, v_period, r.currency, rate_to_inr_for(r.currency));

    SELECT COALESCE(MAX(display_order), -1) + 1 INTO v_ord
      FROM public.invoice_items WHERE invoice_id = v_inv;

    INSERT INTO public.invoice_items
      (invoice_id, agreement_item_id, description, quantity, unit_price, total, currency, display_order)
    VALUES
      (v_inv, r.item_id,
       'Retainer — ' || r.line_label || ' (' || TO_CHAR(v_period, 'Mon YYYY') || ')',
       1, r.unit_price, r.unit_price, COALESCE(r.currency, 'INR'), v_ord)
    ON CONFLICT (invoice_id, agreement_item_id) WHERE agreement_item_id IS NOT NULL
    DO NOTHING;

    PERFORM recalc_invoice_totals(v_inv);
    v_added := v_added + 1;
  END LOOP;

  RETURN v_added;
END;
$$;

COMMIT;
