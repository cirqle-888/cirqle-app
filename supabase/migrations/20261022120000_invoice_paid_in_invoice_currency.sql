-- Foreign-currency invoices are paid in their own currency.
--
-- THE PROBLEM. cashbook_invoice_allocations.allocated_amount is in ₹, and
-- recompute_invoice_from_allocations (20260601000000) turned it back into the
-- invoice's currency at the INVOICE's book rate:
--
--     paid_amount = Σ allocated_amount ÷ invoice.exchange_rate
--
-- So a client who paid an invoice in full, in its own currency, was left
-- owing whatever the rate moved. INV-2609-062: 650 AED billed at 25.904722
-- (₹16,838.07); the client paid 650 AED, which the bank turned into ₹15,000
-- at 23.076923. Stored as 15,000 ÷ 25.904722 = 579.05 AED paid → "partial",
-- with a phantom 70.95 AED due on the receipt. The ₹1,838.07 is a realised
-- FX loss (the Cash Book already shows it as one), not money the client owes.
--
-- THE FIX. Each allocation also carries `allocated_amount_ccy`: its share of
-- the payment in the INVOICE's currency, filled in whenever the paying entry
-- is in that same currency (₹ share × entry.amount ÷ entry.amount_inr). The
-- invoice's paid amount sums that where it exists and falls back to the old
-- book-rate conversion where it doesn't (a USD payment against an AED invoice
-- has no AED amount to use). paid_amount_inr is unchanged: still the ₹ that
-- actually arrived, so the gap to total_amount_inr is the FX difference.
--
--   · BEFORE INSERT / UPDATE on an allocation fills the column, so no caller
--     has to know about it.
--   · Editing a payment entry's currency, amount or ₹ amount refreshes its
--     live allocations, which in turn recomputes their invoices.
--
-- EXISTING DATA. Only allocations whose result actually changes are touched
-- (two on 2026-10-22: INV-2609-062 and INV-2606-058). Recomputing every
-- invoice would also re-derive statuses everywhere (a part-paid bad_debt
-- invoice would become "partial"), so the backfill is deliberately narrow.
-- Safe to re-run.

BEGIN;

-- ── 1. The invoice-currency share ───────────────────────────────────────────
-- No foreign key: it is a derived amount, and adding relationships between
-- these tables has broken PostgREST embeds before (PGRST201, 2026-10-16).
ALTER TABLE public.cashbook_invoice_allocations
  ADD COLUMN IF NOT EXISTS allocated_amount_ccy numeric(15,2);

COMMENT ON COLUMN public.cashbook_invoice_allocations.allocated_amount_ccy IS
  'This allocation in the INVOICE''s currency, when the paying entry is in that currency. NULL = convert allocated_amount at the invoice rate.';

-- ── 2. Fill it on every insert / relevant update ────────────────────────────
CREATE OR REPLACE FUNCTION public.fill_allocation_invoice_ccy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  e_ccy  text;
  e_amt  numeric;
  e_inr  numeric;
  i_ccy  text;
BEGIN
  SELECT upper(coalesce(currency, 'INR')), amount, amount_inr
    INTO e_ccy, e_amt, e_inr
    FROM cashbook_entries WHERE id = NEW.cashbook_entry_id;
  SELECT upper(coalesce(currency, 'INR'))
    INTO i_ccy
    FROM invoices WHERE id = NEW.invoice_id;

  IF e_ccy IS NOT NULL AND e_ccy = i_ccy AND coalesce(e_inr, 0) > 0 AND e_amt IS NOT NULL THEN
    NEW.allocated_amount_ccy := round(NEW.allocated_amount * e_amt / e_inr, 2);
  ELSE
    NEW.allocated_amount_ccy := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_fill_allocation_invoice_ccy ON public.cashbook_invoice_allocations;
CREATE TRIGGER trigger_fill_allocation_invoice_ccy
BEFORE INSERT OR UPDATE OF allocated_amount, cashbook_entry_id, invoice_id
ON public.cashbook_invoice_allocations
FOR EACH ROW EXECUTE FUNCTION public.fill_allocation_invoice_ccy();

-- ── 3. An edited payment entry refreshes its allocations ───────────────────
-- Re-setting allocated_amount fires the BEFORE trigger above (new share) and
-- the existing AFTER trigger (invoice recompute).
CREATE OR REPLACE FUNCTION public.refresh_allocations_on_entry_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.currency   IS DISTINCT FROM OLD.currency
  OR NEW.amount     IS DISTINCT FROM OLD.amount
  OR NEW.amount_inr IS DISTINCT FROM OLD.amount_inr THEN
    UPDATE cashbook_invoice_allocations
       SET allocated_amount = allocated_amount
     WHERE cashbook_entry_id = NEW.id
       AND deleted_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_refresh_allocations_on_entry_change ON public.cashbook_entries;
CREATE TRIGGER trigger_refresh_allocations_on_entry_change
AFTER UPDATE OF currency, amount, amount_inr ON public.cashbook_entries
FOR EACH ROW EXECUTE FUNCTION public.refresh_allocations_on_entry_change();

-- ── 4. Paid amount in the invoice's currency ───────────────────────────────
-- Identical to 20260601000000 except the one marked line.
CREATE OR REPLACE FUNCTION public.recompute_invoice_from_allocations(p_invoice_id uuid)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    total_paid_inr numeric;   -- ₹ base (sum of allocated_amount)
    inv_total      numeric;   -- invoice currency
    inv_rate       numeric;   -- rate_to_inr stamped at invoice creation
    inv_status     text;
    inv_due        date;
    paid_ccy       numeric;   -- invoice currency
    new_status     text;
BEGIN
    IF p_invoice_id IS NULL THEN RETURN; END IF;

    SELECT total_amount, coalesce(nullif(exchange_rate, 0), 1), status, due_date
      INTO inv_total, inv_rate, inv_status, inv_due
      FROM invoices
     WHERE id = p_invoice_id;

    -- ▶ What the client actually paid in the invoice's currency where known;
    --   otherwise the ₹ converted at the invoice's book rate, as before.
    SELECT coalesce(sum(allocated_amount), 0),
           round(coalesce(sum(coalesce(allocated_amount_ccy, allocated_amount / inv_rate)), 0), 2)
      INTO total_paid_inr, paid_ccy
      FROM cashbook_invoice_allocations
     WHERE invoice_id = p_invoice_id
       AND deleted_at IS NULL;

    IF paid_ccy >= inv_total AND inv_total > 0 THEN
        new_status := 'paid';
    ELSIF paid_ccy > 0 THEN
        new_status := 'partial';
    ELSIF inv_due IS NOT NULL AND inv_due < current_date THEN
        new_status := 'overdue';
    ELSE
        IF inv_status IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN
            new_status := inv_status;
        ELSE
            new_status := 'sent';
        END IF;
    END IF;

    UPDATE invoices
       SET paid_amount     = paid_ccy,        -- invoice currency
           paid_amount_inr = total_paid_inr,  -- ₹ that actually arrived
           status          = new_status
     WHERE id = p_invoice_id;
END;
$$;

-- ── 5. Correct only what changes ───────────────────────────────────────────
-- Live allocations paid in the invoice's own (non-₹) currency whose new
-- share differs from the old book-rate conversion. Re-setting
-- allocated_amount fills the column and recomputes just those invoices.
UPDATE public.cashbook_invoice_allocations a
   SET allocated_amount = a.allocated_amount
  FROM public.cashbook_entries e, public.invoices i
 WHERE a.cashbook_entry_id = e.id
   AND a.invoice_id = i.id
   AND a.deleted_at IS NULL
   AND upper(coalesce(i.currency, 'INR')) <> 'INR'
   AND upper(coalesce(e.currency, 'INR')) = upper(coalesce(i.currency, 'INR'))
   AND coalesce(e.amount_inr, 0) > 0
   AND abs(round(a.allocated_amount * e.amount / e.amount_inr, 2)
           - round(a.allocated_amount / coalesce(nullif(i.exchange_rate, 0), 1), 2)) >= 0.01;

COMMIT;

-- PostgREST: a new column on an embedded table.
NOTIFY pgrst, 'reload schema';

-- ── Check after applying (read-only) ────────────────────────────────────────
-- SELECT invoice_number, currency, total_amount, paid_amount, status,
--        total_amount_inr, paid_amount_inr,
--        round(total_amount_inr - paid_amount_inr, 2) AS fx_difference_inr
--   FROM invoices
--  WHERE invoice_number IN ('INV-2609-062', 'INV-2606-058');
-- Expected: INV-2609-062 → 650 / 650, paid, ₹1,838.07 difference (FX loss).
